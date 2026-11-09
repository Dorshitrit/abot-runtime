import { afterEach, beforeEach, expect, test } from "vitest";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildExecutionCapabilityResultSource } from "../steps/execution-agent/capability-result-context.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import { buildExecutionControlsEvidenceMessage } from "../steps/execution-agent/controls-compacted-evidence.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { readCompactionEnvelope, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const tail = "EA_OBSERVATION_UNIQUE_END_MARKER";
const output = ` \n${"observation detail ".repeat(600)}${tail}\n\t `;

test.each([
  { effect: "read_only", lane: "native" },
  { effect: "mixed", lane: "native" },
  { effect: "read_only", lane: "controls" },
  { effect: "mixed", lane: "controls" },
] as const)("EA $effect $lane compacts one original long observation and preserves restore identity", async ({ effect, lane }) => {
  const compact = semanticContractFixture({ policy: "execution-agent-v1" });
  const f = await createControlsEvidenceFixture({
    contextCompactionStore: compact.store,
    modelGatewayClient: compact.params.request.modelGatewayClient,
    runnerConfig: compact.params.request.runnerConfig,
    modelPolicy: compact.params.request.modelPolicy,
  });
  const call = activeEvidenceCall(f.ledger.current());
  expect(call.parentCallId).toBeNull();
  expect(f.ledger.current().policy.authority?.capabilityAuthorities).toEqual(["root"]);
  const observed = observeExternalResult({
    status: "executed", effect, completionActions: [],
    result: { ok: true, tool: "evidence.read", output, producedNewInformation: true },
  }, effect, call.parentCallId === null).result;
  expect(observed.outcome).toBe("succeeded");
  expect(observed).not.toHaveProperty("referenceData");
  expect(observed.exactResult).toMatchObject({ result: { output } });
  await f.commit({
    authority: "active_role", type: "begin_capability_execution",
    callId: call.callId, invocationAttempt: call.activationCount,
    capabilityId: "evidence.read", declaredEffect: "observation",
    intent: "Read exact evidence.", controlsJson: "{}",
  });
  await f.commit({
    authority: "runtime", type: "settle_capability_execution",
    callId: call.callId,
    executionId: f.ledger.current().state.capabilityExecutions.at(-1)!.executionId,
    ...observed,
  });
  const head = f.ledger.current();
  const originalHead = JSON.stringify(head);
  const execution = head.state.capabilityExecutions.at(-1)!;
  const result = projectCanonicalRequestToolResult(head, execution);
  const native = buildExecutionContinuationMessages(head);
  const controls = [buildExecutionControlsEvidenceMessage({
    sourceRevision: head.revision,
    scope: { kind: "call", callId: call.callId }, results: [result],
  }, { requestId: f.request.requestId, callId: call.callId, steering: f.steering.snapshot() })];
  const messages = lane === "native" ? native : controls;
  const original = lane === "native"
    ? buildExecutionCapabilityResultSource(head, execution)
    : createCapabilityResultCompactionSource(result);
  const controller = (request = f.request) => lane === "native"
    ? createExecutionAgentCompactionController(request, {
      head, call, steeringSnapshot: f.steering.snapshot(),
      consumer: "execution.decision", allowedConsumers: ["execution.decision"],
    })
    : createModelStepCompactionController(request, {
      call: { ...call, objective: "Construct controls from the exact observation." },
      sourceRevision: head.revision, scopeSuffix: "controls-observation-regression",
      consumer: "capability.controls", allowedConsumers: ["capability.controls"],
    });
  const active = controller();
  const prepared = await active.getStages()[0]!.prepare(messages);
  if (prepared.kind !== "prepared") throw new Error("test_compaction_missing");
  await prepared.preparation.commit();
  expect(compact.captured.length).toBeGreaterThan(0);
  expect(compact.counted.length).toBeGreaterThan(0);
  for (const input of [...compact.counted, ...compact.captured]) {
    const envelope = readCompactionEnvelope(input);
    const sources = envelope.newSources ?? (envelope.sourceSlice ? [envelope.sourceSlice] : []);
    const source = sources.find(({ sourceRef }) => sourceRef === original.sourceRef);
    if (!source) continue;
    expect(source.content).toBe(original.content);
    expect(source.content.split(tail)).toHaveLength(2);
    const receipt = lane === "native"
      ? JSON.parse(JSON.parse(source.content).content).result
      : JSON.parse(source.content);
    expect(receipt).not.toHaveProperty("referenceData");
    expect(receipt.adapterResult.result.output).toBe(output);
  }
  expect(compact.captured.flatMap((input) => readCompactionEnvelope(input).newSources ?? []))
    .toContainEqual(expect.objectContaining({ sourceRef: original.sourceRef, content: original.content }));
  const snapshot = captureRequestContextCompaction(compact.store);
  expect(snapshot.sources).toContainEqual(original);
  const restored = restoreRequestContextCompaction(snapshot);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  const resumed = controller(deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored }));
  expect(resumed.project(messages)).toEqual(active.project(messages));
  expect(await resumed.getStages()[0]!.prepare(messages)).toEqual({ kind: "unavailable", reason: "no_new_sources" });
  expect(JSON.stringify(f.ledger.current())).toBe(originalHead);
  const unchanged = lane === "native"
    ? buildExecutionCapabilityResultSource(head, execution)
    : createCapabilityResultCompactionSource(projectCanonicalRequestToolResult(head, execution));
  expect(unchanged).toEqual(original);
});
