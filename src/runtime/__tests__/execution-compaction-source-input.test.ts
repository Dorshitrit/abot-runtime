import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { createSemanticCompactionSha256Fingerprint as hash, type SemanticCompactionSource } from "../context/semantic-compaction/contracts.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectRoleSettledCapabilityResults } from "../orchestration/worker-capabilities/settled-results.js";
import { projectPayloadSettledEvidence } from "../request/payload-settled-evidence.js";
import { buildExecutionControlsEvidenceMessage } from "../steps/execution-agent/controls-compacted-evidence.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { readCompactionEnvelope, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type InputSource = SemanticCompactionSource & {
  sourceKey: string;
  range?: { startByte: number; endByteExclusive: number; totalBytes: number };
  sliceFingerprint?: string;
};
function inputSources(messages: readonly ChatMessage[]): readonly InputSource[] {
  const envelope = readCompactionEnvelope(messages);
  return (envelope.newSources ?? (envelope.sourceSlice ? [envelope.sourceSlice] : [])) as readonly InputSource[];
}

test.each((["controls", "payload"] as const).flatMap((lane) => [
  { sliced: false, supplementary: false }, { sliced: true, supplementary: false },
  { sliced: false, supplementary: true }, { sliced: true, supplementary: true },
].map((params) => ({ ...params, lane }))))("EA $lane preserves original identities with sliced=$sliced supplementary=$supplementary", async ({ sliced, supplementary, lane }) => {
  const compact = semanticContractFixture({ policy: "execution-agent-v1", sliced });
  const f = await createControlsEvidenceFixture({
    contextCompactionStore: compact.store,
    modelGatewayClient: compact.params.request.modelGatewayClient,
    runnerConfig: compact.params.request.runnerConfig,
    modelPolicy: compact.params.request.modelPolicy,
  });
  const call = activeEvidenceCall(f.ledger.current());
  const output = ` \n${"observed שינוי 🧪 ".repeat(800)}MUTATION_END_MARKER\n\t `;
  const grounding = supplementary ? "Independent verification: target matches the requested state." : output.trim();
  const observed = observeExternalResult({
    status: "executed", effect: "mutating", completionActions: [],
    result: { ok: true, tool: "evidence.apply", output, producedNewInformation: true,
      data: { mutationEvidence: true, mutationGrounding: grounding } },
  }, "mutating", call.parentCallId === null).result;
  expect(observed).toMatchObject({ outcome: "succeeded", observedEffect: "mutation", referenceData: grounding });
  await f.commit({
    authority: "active_role", type: "begin_capability_execution",
    callId: call.callId, invocationAttempt: call.activationCount,
    capabilityId: "evidence.apply", declaredEffect: "mutation",
    intent: "Apply the accepted mutation.", controlsJson: "{}",
  });
  await f.commit({
    authority: "runtime", type: "settle_capability_execution", callId: call.callId,
    executionId: f.ledger.current().state.capabilityExecutions.at(-1)!.executionId,
    ...observed,
  });
  const head = f.ledger.current();
  const originalHead = JSON.stringify(head);
  const execution = head.state.capabilityExecutions.at(-1)!;
  const result = projectCanonicalRequestToolResult(head, execution);
  const settled = projectRoleSettledCapabilityResults({ ledger: f.ledger, head, call: activeEvidenceCall(head) });
  const payload = projectPayloadSettledEvidence(settled);
  const original = lane === "controls"
    ? createCapabilityResultCompactionSource(result)
    : payload.resultSourceOverrides[0]!;
  expect(JSON.parse(original.content).referenceData).toBe(grounding);
  const messages: readonly ChatMessage[] = lane === "controls" ? [buildExecutionControlsEvidenceMessage({
    sourceRevision: head.revision, scope: { kind: "call", callId: call.callId }, results: [result],
  }, { requestId: f.request.requestId, callId: call.callId, steering: f.steering.snapshot() })] : [{
    role: "user", content: `Canonical runtime context:\n${JSON.stringify({ settledCapabilityResults: payload.results })}`,
  }];
  const consumer = lane === "controls" ? "capability.controls" : "tool_payload.raw";
  const controller = (request = f.request) => createModelStepCompactionController(request, {
    call: { ...call, objective: "Construct the operation from the settled mutation evidence." },
    sourceRevision: head.revision, scopeSuffix: `${lane}-source-input-regression`,
    consumer, allowedConsumers: [consumer],
    ...(lane === "payload" ? { resultSourceOverrides: payload.resultSourceOverrides } : {}),
  });
  const active = controller();
  const prepared = await active.getStages()[0]!.prepare(messages);
  if (prepared.kind !== "prepared") throw new Error("test_compaction_missing");
  await prepared.preparation.commit();
  const supplied = compact.captured.flatMap(inputSources);
  expect(supplied.length).toBeGreaterThan(sliced ? 1 : 0);
  const suppliedContent = supplied.map(({ content }) => content).join("");
  const receipt = JSON.parse(suppliedContent);
  if (supplementary) expect(receipt.referenceData).toBe(grounding);
  else expect(receipt).not.toHaveProperty("referenceData");
  expect(receipt.adapterResult).toEqual(result.adapterResult);
  expect(receipt.adapterResult.result.output).toBe(output);
  // Keep the independent adapter envelope intact, including its own grounding field.
  expect(receipt.adapterResult.result.data.mutationGrounding).toBe(grounding);
  const suppliedHash = hash(suppliedContent);
  expect(suppliedHash === original.sourceFingerprint).toBe(supplementary);
  let coveredBytes = 0;
  for (const source of supplied) {
    expect(source.sourceKey).toBe("source_0");
    expect(source.sourceRef).toBe(original.sourceRef);
    expect(source.sourceFingerprint).toBe(suppliedHash);
    if (sliced) {
      expect(source.range?.startByte).toBe(coveredBytes);
      coveredBytes += Buffer.byteLength(source.content, "utf8");
      expect(source.range?.endByteExclusive).toBe(coveredBytes);
      expect(source.range?.totalBytes).toBe(Buffer.byteLength(suppliedContent, "utf8"));
      expect(source.sliceFingerprint).toBe(hash(source.content));
    }
  }
  for (const source of compact.counted.flatMap(inputSources)) {
    expect(source.sourceFingerprint).toBe(suppliedHash);
    const expected = source.range
      ? Buffer.from(suppliedContent).subarray(source.range.startByte, source.range.endByteExclusive).toString("utf8")
      : suppliedContent;
    expect(source.content).toBe(expected);
  }
  const snapshot = captureRequestContextCompaction(compact.store);
  expect(snapshot.sources).toEqual([original]);
  expect(snapshot.checkpoints[0]!.sourceDigests).toEqual([
    expect.objectContaining({ sourceRef: original.sourceRef, sourceFingerprint: original.sourceFingerprint }),
  ]);
  const restored = restoreRequestContextCompaction(snapshot);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  const resumed = controller(deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored }));
  expect(resumed.project(messages)).toEqual(active.project(messages));
  expect(await resumed.getStages()[0]!.prepare(messages)).toEqual({ kind: "unavailable", reason: "no_new_sources" });
  expect(JSON.stringify(f.ledger.current())).toBe(originalHead);
  const unchanged = lane === "controls"
    ? createCapabilityResultCompactionSource(projectCanonicalRequestToolResult(head, execution))
    : projectPayloadSettledEvidence(settled).resultSourceOverrides[0];
  expect(unchanged).toEqual(original);
});
