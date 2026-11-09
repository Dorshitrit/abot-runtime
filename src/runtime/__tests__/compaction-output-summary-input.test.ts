import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestToolResult } from "../context/request-tool-results.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { projectCompactionSourceInput } from "../context/compaction-source-input.js";
import { createSemanticCompactionSha256Fingerprint as hash, type SemanticCompactionSource } from "../context/semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const output = "  EXACT_OBSERVED_OUTPUT עברית🙂\n";

test.each(["canonical", "payload"] as const)("%s removes an exact summary independently of the reference-data alias", (kind) => {
  for (const referenceData of [undefined, output, output.trim(), "Independent supplementary evidence."]) {
    const original = receipt(output, referenceData);
    const source = receiptSource(original, kind);
    const saved = source.content;
    const projected = projectCompactionSourceInput(source);
    const view = JSON.parse(projected.content);
    const { summary: _summary, referenceData: originalReference, ...remaining } = JSON.parse(saved);
    const retainedReference = originalReference === "Independent supplementary evidence."
      ? { referenceData: originalReference } : {};
    expect(view).toEqual({ ...remaining, ...retainedReference });
    expect(view).not.toHaveProperty("summary");
    expect(view.adapterResult.result.output).toBe(output);
    expect(projected.sourceRef).toBe(source.sourceRef);
    expect(projected.sourceFingerprint).toBe(hash(projected.content));
    expect(source.content).toBe(saved);
    expect(source.sourceFingerprint).toBe(hash(saved));
  }
});

test.each(["canonical", "payload"] as const)("%s keeps distinct, trimmed and near-equal summaries byte-identical", (kind) => {
  for (const summary of [output.trim(), output + " ", output.replace("OBSERVED", "observed"), "Independent observation summary."]) {
    const source = receiptSource(receipt(summary), kind);
    expect(projectCompactionSourceInput(source)).toBe(source);
  }
});

test("reference-data alias removal preserves a distinct summary", () => {
  const original = receipt("Independent observation summary.", output.trim());
  const source = receiptSource(original, "payload");
  const view = JSON.parse(projectCompactionSourceInput(source).content);
  expect(view.summary).toBe(original.summary);
  expect(view).not.toHaveProperty("referenceData");
  expect(view.adapterResult).toEqual(original.adapterResult);
});

test.each(["embedded_exact_result", "embedded_cross_call_exact_result"])(
  "%s removes the exact summary only inside its authenticated receipt",
  (kind) => {
    const f = supervisionSource(receipt(output, "Supplementary supervision evidence."), kind);
    const view = readSupervision(projectCompactionSourceInput(f.source));
    const { summary: _summary, ...remaining } = f.record.entries[0]!.evidence.receipt;
    expect(view).toEqual({ ...f.record, entries: [{ ...f.record.entries[0], evidence: {
      ...f.record.entries[0]!.evidence, receipt: remaining,
    } }] });
    expect(view.entries[0].evidence.adapterResult.result.output).toBe(output);
    expect(view.entries[0].evidence.receipt.referenceData).toBe("Supplementary supervision evidence.");
    expect(f.source).toEqual(sourceForRecord(f.record));
  },
);

test("supervision keeps nonidentical summaries and unrecognized or mismatched ownership unchanged", () => {
  const f = supervisionSource(receipt());
  const entry = f.record.entries[0]!;
  const cases = [
    supervisionSource(receipt(output.trim())).source,
    supervisionSource(receipt(output + " ")).source,
    supervisionSource(receipt(), "unknown_evidence").source,
    sourceForRecord({ ...f.record, authority: "user" }),
    sourceForRecord({ ...f.record, entries: [{ ...entry, originExecutionId: "other-execution" }] }),
    sourceForRecord({ ...f.record, entries: [{ ...entry, evidence: {
      ...entry.evidence, receipt: { ...entry.evidence.receipt, unknownField: true },
    } }] }),
    { ...f.source, sourceRef: `operation-supervision-evidence:${hash("another owner").slice(7)}` },
  ];
  for (const source of cases) expect(projectCompactionSourceInput(source)).toBe(source);
});

test("generic, unknown and tampered source shapes do not authorize summary removal", () => {
  const original = receipt();
  const generic: RequestToolResult = { ...original, adapterResult: {
    kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true,
    payload: { output },
  } };
  const cases = [
    receiptSource(generic, "canonical"),
    receiptSource(generic, "payload"),
    sourceWith(JSON.stringify({ ...original, unknownField: true })),
    sourceWith(JSON.stringify({ ...original, adapterResult: { ...original.adapterResult, authority: "user" } })),
    sourceWith(JSON.stringify(original), "other-execution"),
    sourceWith(JSON.stringify(original), "payload-result:other-execution"),
    sourceWith(JSON.stringify({ userDocument: original })),
  ];
  for (const source of cases) expect(projectCompactionSourceInput(source)).toBe(source);
  const source = receiptSource(original, "canonical");
  expect(() => projectCompactionSourceInput({ ...source, content: source.content + " " }))
    .toThrow("context_compaction_source_content_mismatch");
});

test("generation counts and sends the same single-copy body while checkpoints retain original source fingerprints", async () => {
  const largeOutput = "OBSERVED_SOURCE_עברית🙂; verification pending.\n".repeat(100);
  const original = receipt(largeOutput, "Distinct supplementary detail.", largeOutput);
  const source = receiptSource(original, "canonical");
  const store = createRequestContextCompactionStore();
  store.registerSources([source]);
  const saved = captureRequestContextCompaction(store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(saved)));
  const projected = projectCompactionSourceInput(source);
  const counted = new Set<string>();
  const sent: Array<{ step: string; sourceFingerprint: string; content: string }> = [];
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    counted.add(JSON.stringify([input.modelStep, input.messages]));
    const invocation = resolveModelInvocation(input);
    return { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(input.messages), "utf8") / 4),
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(counted.has(JSON.stringify([input.modelStep, input.messages]))).toBe(true);
    const user = (input.messages as readonly ChatMessage[]).find(({ role }) => role === "user")!;
    const slice = JSON.parse(user.content).baseCapsule.sourceSlice;
    sent.push({ step: input.modelStep!, sourceFingerprint: slice.sourceFingerprint, content: slice.content });
    return { text: "Observed source preserved; verification remains pending.", meta: {} };
  });
  const originalRequest = createCompactionRequest({ requestId: "summary-input-copy", prompt: "Preserve the observed source.", invoke, store: restored });
  const request = deriveTestRequestExecutionScope(originalRequest, {
    ...projectSuperCompactionConfiguration(originalRequest, originalRequest.executionPolicy.authority),
    modelGatewayClient: { ...originalRequest.modelGatewayClient, countInputTokens },
  });
  const params: SemanticCompactionGenerationParams = { request, scopeId: "worker:summary-input", sourceRevision: 1,
    preservationObjective: request.prompt, consumer: "worker.result", sources: [source],
    binding: { requestId: request.requestId, currentRequestFingerprint: hash(request.prompt), roleId: "worker", callId: "worker-1",
      objectiveFingerprint: hash(request.prompt), contextLane: "role_continuation", allowedConsumers: ["worker.result"] },
  };
  const candidate = await generateSuperCompactionCandidate(params);
  expect(sent.map(({ step }) => step)).toEqual([
    "super.compact.coverage", "super.compact.content", "super.compact.continuation",
  ]);
  expect(sent.every(({ content, sourceFingerprint }) => content === projected.content && sourceFingerprint === projected.sourceFingerprint)).toBe(true);
  const view = JSON.parse(sent[0]!.content);
  expect(view).not.toHaveProperty("summary");
  expect(view.referenceData).toBe("Distinct supplementary detail.");
  expect(view.adapterResult.result.output).toBe(largeOutput);
  expect(candidate.sourceDigests[0]).toMatchObject({ sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint });
  expect(captureRequestContextCompaction(restored)).toEqual(saved);
  restored.commit(candidate);
  const roundTrip = restoreRequestContextCompaction(captureRequestContextCompaction(restored));
  expect(roundTrip.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
  expect(roundTrip.materializeSource(projected.sourceRef, projected.sourceFingerprint)).toBeUndefined();
  expect(roundTrip.get(params.scopeId)).toEqual(candidate);
});

function receipt(summary = output, referenceData?: string, exactOutput = output): RequestToolResult {
  return { executionId: "execution-1", callId: "worker-1", invocationAttempt: 1,
    capabilityId: "read", declaredEffect: "observation", outcome: "succeeded", observedEffect: "observation", summary,
    ...(referenceData === undefined ? {} : { referenceData }),
    references: [{ kind: "tool_target", target: "input.txt" }],
    adapterResult: { kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: { tool: "read", ok: true, producedNewInformation: true, output: exactOutput, data: { source: "keep" } } },
  };
}

function receiptSource(value: RequestToolResult, kind: "canonical" | "payload"): SemanticCompactionSource {
  if (kind === "canonical") return createCapabilityResultCompactionSource(value);
  return sourceWith(JSON.stringify(value), `payload-result:${value.executionId}`);
}

function sourceWith(content: string, sourceRef = "execution-1"): SemanticCompactionSource {
  return { sourceRef, content, sourceFingerprint: hash(content) };
}

function supervisionSource(value: RequestToolResult, kind = "embedded_exact_result") {
  const { adapterResult, ...receipt } = value;
  const record = { kind: "runtime_operation_supervision_evidence_v1", authority: "canonical_role_call_ledger",
    sourceRevision: 3, binding: { callId: "worker-2", invocationAttempt: 2 }, entries: [{
      originExecutionId: value.executionId, notice: { purpose: "Preserve supervision notice." },
      evidence: { kind, receipt, adapterResult, acceptedAction: { intent: "Read the selected source." } },
    }] };
  return { record, source: sourceForRecord(record) };
}

function sourceForRecord(record: unknown): SemanticCompactionSource {
  const message = { role: "user", content: JSON.stringify(record) };
  return sourceWith(JSON.stringify(message), `operation-supervision-evidence:${hash(message.content).slice(7)}`);
}

function readSupervision(source: SemanticCompactionSource) {
  return JSON.parse(JSON.parse(source.content).content);
}
