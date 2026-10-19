import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { requiresContextCompaction } from "../model/context-compaction-admission.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";
import { projectPayloadSettledEvidence } from "../request/payload-settled-evidence.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { mixedWorkerFixture } from "./support/super-mixed-compaction-fixture.js";
import { readCompactionEnvelope } from "./support/semantic-compaction-contract-fixture.js";
import { semanticCompactionReplacementSlots } from "./support/semantic-compaction-replacement-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function originalResult(body = "EXACT_ORIGINAL_REFERENCE"): WorkerSettledCapabilityResult {
  return Object.freeze({
    executionId: "capability-execution-1",
    callId: "call-1",
    invocationAttempt: 1,
    capabilityId: "example.observe",
    declaredEffect: "observation",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Observed the requested value.",
    referenceData: body,
    adapterResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { nested: { observation: body } },
    } as const,
  });
}

function payloadMessage(results: readonly unknown[]): ChatMessage {
  return {
    role: "user",
    content: `Canonical runtime context:\n${JSON.stringify({ settledCapabilityResults: results })}`,
  };
}

function payloadRecord(messages: readonly ChatMessage[]) {
  const message = messages.find(({ content }) => content.startsWith("Canonical runtime context:\n"));
  if (!message) throw new Error("payload_context_missing");
  return JSON.parse(message.content.slice("Canonical runtime context:\n".length));
}

function oldCheckpoint(params: {
  requestId: string;
  prompt: string;
  roleId: "root" | "worker";
  original: WorkerSettledCapabilityResult;
}): SemanticCompactionCheckpoint {
  const content = JSON.stringify(params.original);
  const sourceRef = `payload-result:${params.original.executionId}`;
  return {
    kind: "runtime_semantic_compaction_checkpoint_v2",
    requestId: params.requestId,
    currentRequestFingerprint: hash(params.prompt),
    roleId: params.roleId,
    callId: params.original.callId,
    objectiveFingerprint: hash(params.prompt),
    contextLane: "role_continuation",
    scopeId: "payload:call-1:capability-execution-2:0",
    sourceRevision: 2,
    allowedConsumers: ["tool_payload.raw"],
    sourceDigests: [{ sourceRef, sourceFingerprint: hash(content), digest: "ORIGINAL_FACT_PRESERVED" }],
    continuation: {
      completed: ["Observed the requested value."],
      currentState: "Evidence is ready.",
      findings: ["ORIGINAL_FACT_PRESERVED"],
      evidenceRefs: [sourceRef],
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: ["Author the accepted output."],
      blockers: [],
      nextStep: "Use the observed evidence.",
    },
  };
}

test.each(["root", "worker"] as const)(
  "%s payload reuses an old restored checkpoint without replacing source bytes or calling compaction",
  async (roleId) => {
    const fixture = await createControlsEvidenceFixture();
    const original = originalResult();
    const checkpoint = oldCheckpoint({
      requestId: fixture.request.requestId,
      prompt: fixture.request.prompt,
      roleId,
      original,
    });
    const store = createRequestContextCompactionStore();
    store.registerSources([{
      sourceRef: checkpoint.sourceDigests[0]!.sourceRef,
      sourceFingerprint: checkpoint.sourceDigests[0]!.sourceFingerprint,
      content: JSON.stringify(original),
    }]);
    store.commit(checkpoint);
    const snapshot = captureRequestContextCompaction(store);
    const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
    const request = deriveTestRequestExecutionScope(fixture.request, { contextCompactionStore: restored });
    const representation = projectPayloadSettledEvidence([original]);
    const controller = createModelStepCompactionController(request, {
      call: { roleId, callId: original.callId, objective: request.prompt },
      sourceRevision: 2,
      consumer: "tool_payload.raw",
      allowedConsumers: ["tool_payload.raw"],
      scopeId: checkpoint.scopeId,
      resultSourceOverrides: representation.resultSourceOverrides,
    });

    const projected = controller.project([payloadMessage(representation.results)]);
    const canonical = payloadRecord(projected);
    expect(canonical.settledCapabilityResults).toEqual([]);
    expect(canonical.semanticCheckpoint.coveredSources).toEqual(checkpoint.sourceDigests);
    expect(canonical.semanticCheckpoint.coveredResults[0].sourceFingerprint).toBe(hash(JSON.stringify(original)));
    expect(JSON.stringify(projected)).not.toContain("EXACT_ORIGINAL_REFERENCE");
    expect(JSON.stringify(projected)).toContain("ORIGINAL_FACT_PRESERVED");
    await expect(controller.getStages()[0]!.prepare(projected)).resolves.toMatchObject({ kind: "unavailable" });
    expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
    expect(fixture.invoke).not.toHaveBeenCalled();
  },
);

test("SUPER Worker canonical source overrides take precedence over payload aliases", async () => {
  const mixed = await mixedWorkerFixture(false, "Target evidence.");
  const fixture = await createControlsEvidenceFixture();
  const sidecar = readSuperWorkerCompactionSidecar(mixed.view)!;
  expect(sidecar).toBeDefined();
  const representation = projectPayloadSettledEvidence(mixed.view.results as readonly WorkerSettledCapabilityResult[]);
  expect(representation.resultSourceOverrides).toHaveLength(2);
  const snapshot = captureRequestContextCompaction(mixed.store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
  const request = deriveTestRequestExecutionScope(fixture.request, {
    requestId: mixed.head.state.requestId,
    prompt: "Inspect the target.",
    contextCompactionStore: restored,
  });
  const controller = createModelStepCompactionController(request, {
    call: mixed.call,
    sourceRevision: mixed.head.revision,
    consumer: "tool_payload.raw",
    allowedConsumers: mixed.checkpoint.allowedConsumers,
    scopeId: mixed.checkpoint.scopeId,
    superWorkerCompaction: sidecar,
    requireSuperWorkerSources: true,
    resultSourceOverrides: representation.resultSourceOverrides,
  });

  const projected = controller.project([payloadMessage(representation.results)]);
  expect(payloadRecord(projected).settledCapabilityResults).toEqual([]);
  expect(payloadRecord(projected).semanticCheckpoint.coveredSources).toEqual(mixed.checkpoint.sourceDigests);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("duplicate removal lowers context admission pressure without reducing facts or changing the threshold", () => {
  const original = originalResult("COMPLETE_EVIDENCE ".repeat(900));
  const projection = projectPayloadSettledEvidence([original]);
  const budget = {
    contextWindowTokens: 24_000,
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 0,
  };
  const before = assessRequestMessagesBudget({ messages: [payloadMessage([original])], budget });
  const after = assessRequestMessagesBudget({ messages: [payloadMessage(projection.results)], budget });
  expect(before.budget.estimatedInputTokens).toBeGreaterThan(after.budget.estimatedInputTokens);
  const between = Math.ceil((before.budget.estimatedInputTokens + after.budget.estimatedInputTokens) / 1.4);
  const matchingBudget = { ...budget, contextWindowTokens: between };
  expect(requiresContextCompaction(true, assessRequestMessagesBudget({
    messages: [payloadMessage([original])], budget: matchingBudget,
  }))).toBe(true);
  expect(requiresContextCompaction(true, assessRequestMessagesBudget({
    messages: [payloadMessage(projection.results)], budget: matchingBudget,
  }))).toBe(false);
  expect(projection.results[0]).toHaveProperty("adapterResult", original.adapterResult);
});

test("an already verified EA digest stays a receipt and never becomes a new payload compaction source", async () => {
  const fixture = await createControlsEvidenceFixture();
  const original = originalResult();
  const { adapterResult: _adapter, referenceData: _reference, ...metadata } = original;
  const receipt = { ...metadata, compactedSourceRef: "tool-result:capability-execution-1" };
  const representation = projectPayloadSettledEvidence([receipt]);
  const controller = createModelStepCompactionController(fixture.request, {
    call: { roleId: "root", callId: original.callId, objective: fixture.request.prompt },
    sourceRevision: 2,
    consumer: "tool_payload.raw",
    allowedConsumers: ["tool_payload.raw"],
    scopeId: "payload:call-1:capability-execution-2:0",
    resultSourceOverrides: representation.resultSourceOverrides,
  });
  const message: ChatMessage = {
    role: "user",
    content: `Canonical runtime context:\n${JSON.stringify({
      settledCapabilityResults: representation.results,
      compactedSourceEvidence: {
        kind: "runtime_payload_compacted_source_evidence_v1",
        sources: [{ sourceRef: receipt.compactedSourceRef, digest: "EA_ALREADY_PRESERVED_FACT" }],
      },
    })}`,
  };
  const projected = controller.project([message]);
  expect(payloadRecord(projected).settledCapabilityResults).toEqual([receipt]);
  expect(JSON.stringify(projected)).toContain("EA_ALREADY_PRESERVED_FACT");
  await expect(controller.getStages()[0]!.prepare(projected)).resolves.toEqual({
    kind: "unavailable", reason: "no_eligible_sources",
  });
  expect(captureRequestContextCompaction(fixture.request.contextCompactionStore!).sources).toEqual([]);
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("new payload compaction registers the original bytes despite the smaller model representation", async () => {
  const fixture = await createControlsEvidenceFixture();
  const original = originalResult();
  const checkpoint = oldCheckpoint({
    requestId: fixture.request.requestId,
    prompt: fixture.request.prompt,
    roleId: "root",
    original,
  });
  const representation = projectPayloadSettledEvidence([original]);
  fixture.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe("context.compact");
    const envelope = readCompactionEnvelope(input.messages as readonly ChatMessage[]);
    expect(envelope.newSources).toMatchObject([{
      sourceRef: checkpoint.sourceDigests[0]!.sourceRef,
      sourceFingerprint: hash(JSON.stringify(original)),
      content: JSON.stringify(original),
    }]);
    return {
      text: JSON.stringify({
        continuation: checkpoint.continuation,
        sourceDigests: semanticCompactionReplacementSlots(envelope, () => "ORIGINAL_FACT_PRESERVED"),
      }),
      meta: {},
    };
  });
  const controller = createModelStepCompactionController(fixture.request, {
    call: { roleId: "root", callId: original.callId, objective: fixture.request.prompt },
    sourceRevision: 2,
    consumer: "tool_payload.raw",
    allowedConsumers: ["tool_payload.raw"],
    scopeId: checkpoint.scopeId,
    resultSourceOverrides: representation.resultSourceOverrides,
  });
  const prepared = await controller.getStages()[0]!.prepare([payloadMessage(representation.results)]);
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error("expected_compaction_preparation");
  await prepared.preparation.commit();
  const snapshot = captureRequestContextCompaction(fixture.request.contextCompactionStore!);
  expect(snapshot.sources).toEqual([{
    sourceRef: checkpoint.sourceDigests[0]!.sourceRef,
    sourceFingerprint: hash(JSON.stringify(original)),
    content: JSON.stringify(original),
  }]);
  expect(payloadRecord(prepared.preparation.messages).settledCapabilityResults).toEqual([]);
});

test("the request-bound root payload author forwards source identity through a restored checkpoint", async () => {
  const fixture = await createControlsEvidenceFixture();
  const original = originalResult();
  const originalBytes = JSON.stringify(original);
  const checkpoint = oldCheckpoint({
    requestId: fixture.request.requestId,
    prompt: fixture.request.prompt,
    roleId: "root",
    original,
  });
  const store = createRequestContextCompactionStore();
  store.registerSources([{
    sourceRef: checkpoint.sourceDigests[0]!.sourceRef,
    sourceFingerprint: hash(originalBytes),
    content: originalBytes,
  }]);
  store.commit(checkpoint);
  const snapshot = captureRequestContextCompaction(store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
  const request = deriveTestRequestExecutionScope(fixture.request, {
    contextCompactionStore: restored,
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: { ...fixture.request.runnerConfig.steps, "tool_payload.raw": { timeoutMs: 20_000 } },
    },
    modelPolicy: {
      ...fixture.request.modelPolicy!,
      defaults: { profileId: "test", steps: { "tool_payload.raw": "toolPayload.raw" } },
    },
  });
  fixture.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe("tool_payload.raw");
    const canonical = payloadRecord(input.messages as readonly ChatMessage[]);
    expect(canonical.settledCapabilityResults).toEqual([]);
    expect(canonical.semanticCheckpoint.coveredSources).toEqual(checkpoint.sourceDigests);
    expect(JSON.stringify(input.messages)).toContain("ORIGINAL_FACT_PRESERVED");
    expect(JSON.stringify(input.messages)).not.toContain("EXACT_ORIGINAL_REFERENCE");
    return { text: "complete payload", meta: {} };
  });
  const author = createRequestWorkerCapabilityPayloadAuthor(request, ["root"]);
  await expect(author.author({
    call: {
      callId: "call-1", parentCallId: null, roleId: "supervisor", depth: 0,
      objective: null, dependencyResultRefs: [], status: "active",
      childCallIds: [], activationCount: 2, resultRef: null,
    },
    executionId: "capability-execution-2",
    descriptor: {
      capabilityId: "example.write", summary: "Write the accepted output.", effect: "mutation",
      requiresPayloadAuthoringObjective: true,
      controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
    authoringObjective: "Author the accepted output using the observed facts.",
    controls: {},
    requestSteering: { kind: "request_steering_v1", version: 0, updates: [] },
    settledCapabilityResults: [original],
    contract: { instructions: "Return the accepted output body.", minBytes: 1, maxBytes: 128 },
  })).resolves.toEqual({ status: "authored", body: "complete payload" });
  expect(fixture.invoke).toHaveBeenCalledOnce();
  expect(JSON.stringify(original)).toBe(originalBytes);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
});
