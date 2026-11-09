import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidateBatched, type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { projectSuperContinuation } from "../context/super-compaction/continuation-projection.js";
import { resolveModelContextAdmission } from "../model/model-context-budget.js";
import { createModelContextAssessment } from "../model/model-context-assessment.js";
import { admitCompactedContext, requiresContextCompaction } from "../model/context-compaction-admission.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("restored old digests are reduced when their checkpoint fits but the complete input does not shrink", async () => {
  const f = fixture();
  const admitted = await f.run();
  expect(f.fullCounts[0]!).toBeGreaterThanOrEqual(11_200);
  // The fresh source wrappers make the first retained candidate larger than its input.
  expect(f.fullCounts[1]!).toBeGreaterThan(f.fullCounts[0]!);
  expect(tokens(admitted.messages)).toBeLessThan(f.fullCounts[0]!);
  expect(admitted.assessment.fits).toBe(true);
  expect(f.checkpointCounts.length).toBeGreaterThan(1);
  expect(f.checkpointCounts.every((count) => count < 4_800)).toBe(true);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === "old-source").map(({ step }) => step))
    .toEqual(["super.compact.coverage", "super.compact.content"]);
  expectFreshSourcesProcessedOnce(f.calls);
  const committed = f.store.get(f.previous.scopeId)!;
  expect(committed).not.toBe(f.previous);
  expect(committed.sourceDigests[0]!.digest).toContain("COMPACTED_OLD_FACT");
  expect(committed.sourceDigests[0]!.digest.length).toBeLessThan(f.previous.sourceDigests[0]!.digest.length);
  expect(committed.continuation.currentState).toBe("Fresh handoff: tool-result:fresh-read");
  expect(f.measuredCheckpoints.every((checkpoint) => checkpoint === f.previous)).toBe(true);
  expect(f.store.materializeSource(f.oldSource.sourceRef, f.oldSource.sourceFingerprint)).toEqual(f.oldSource);
});

test("exhausting old-source reduction without full-envelope capacity leaves the saved checkpoint unchanged", async () => {
  const f = fixture({ prefixRepeats: 3_100 });
  await expect(f.run()).rejects.toThrow("context_compaction_projection_not_reduced");
  expect(f.checkpointCounts.every((count) => count < 4_800)).toBe(true);
  expect(f.fullCounts.at(-1)!).toBeGreaterThan(13_352);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === "old-source").map(({ step }) => step))
    .toEqual(["super.compact.coverage", "super.compact.content"]);
  expectFreshSourcesProcessedOnce(f.calls);
  expect(f.store.get(f.previous.scopeId)).toBe(f.previous);
  expect(f.measuredCheckpoints.every((checkpoint) => checkpoint === f.previous)).toBe(true);
});

test("a full-input counter failure propagates before old-source reduction or checkpoint commit", async () => {
  const countFailure = new Error("consumer_counter_unavailable");
  const f = fixture({ countFailure });
  await expect(f.run()).rejects.toBe(countFailure);
  expect(f.calls.every(({ sourceRef }) => sourceRef !== "old-source")).toBe(true);
  expectFreshSourcesProcessedOnce(f.calls);
  expect(f.store.get(f.previous.scopeId)).toBe(f.previous);
});

test("EA generation ignores the optional SUPER retention probe and keeps its measurement sequence", async () => {
  const ordinary = semanticContractFixture({ policy: "execution-agent-v1" });
  const withProbe = semanticContractFixture({ policy: "execution-agent-v1" });
  const canRetainCandidate = vi.fn(async () => { throw new Error("SUPER probe must not run for EA"); });
  await generateSemanticCompactionCandidateBatched(ordinary.params);
  await generateSemanticCompactionCandidateBatched({ ...withProbe.params, canRetainCandidate });
  expect(canRetainCandidate).not.toHaveBeenCalled();
  expect(withProbe.counted).toEqual(ordinary.counted);
  expect(withProbe.captured).toEqual(ordinary.captured);
});

type StageCall = Readonly<{ step: string; sourceRef: string }>;

function expectFreshSourcesProcessedOnce(calls: readonly StageCall[]): void {
  const fresh = calls.filter(({ sourceRef }) => sourceRef !== "old-source");
  expect(fresh).toHaveLength(2);
  expect(new Set(fresh.map(({ sourceRef }) => sourceRef)).size).toBe(2);
  expect(fresh.every(({ step }) => step === "super.compact.continuation")).toBe(true);
}

function tokens(messages: readonly ChatMessage[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4);
}

function fixture(options: { prefixRepeats?: number; countFailure?: Error } = {}) {
  const calls: StageCall[] = [];
  const fullCounts: number[] = [];
  const checkpointCounts: number[] = [];
  const measuredCheckpoints: Array<SemanticCompactionCheckpoint | undefined> = [];
  let readSavedCheckpoint: (() => SemanticCompactionCheckpoint | undefined) | undefined;
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const count = tokens(messages);
    if (input.modelStep === "worker.result") {
      if (messages.length === 1) checkpointCounts.push(count);
      else fullCounts.push(count);
      measuredCheckpoints.push(readSavedCheckpoint?.());
      if (messages.length > 1 && fullCounts.length === 2 && options.countFailure) throw options.countFailure;
    }
    const invocation = resolveModelInvocation(input);
    return { inputTokens: count, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count" };
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const envelope = JSON.parse((input.messages as readonly ChatMessage[]).find(({ role }) => role === "user")!.content);
    const sourceRef = (envelope.baseCapsule.sourceSlice ?? envelope.baseCapsule.source).sourceRef as string;
    calls.push({ step: input.modelStep!, sourceRef });
    return { text: input.modelStep === "super.compact.continuation"
      ? `Fresh handoff: ${sourceRef}` : "COMPACTED_OLD_FACT", meta: {} };
  });
  const original = createCompactionRequest({ requestId: "super-retained-full-input", prompt: "Continue the requested work.", invoke });
  let request = deriveTestRequestExecutionScope(original, {
    ...projectSuperCompactionConfiguration(original, original.executionPolicy.authority),
    modelGatewayClient: { ...original.modelGatewayClient, invoke, countInputTokens },
  });
  const content = "Canonical original observation. ".repeat(200);
  const oldSource = { sourceRef: "old-source", content, sourceFingerprint: hash(content) };
  const previousInput: SemanticCompactionCheckpoint = {
    kind: "runtime_semantic_compaction_checkpoint_v2", requestId: request.requestId,
    currentRequestFingerprint: hash(request.prompt), roleId: "worker", callId: "worker-1",
    objectiveFingerprint: hash(request.prompt), contextLane: "role_continuation", allowedConsumers: ["worker.result"],
    scopeId: "worker-retained-full-input", sourceRevision: 1,
    sourceDigests: [{ sourceRef: oldSource.sourceRef, sourceFingerprint: oldSource.sourceFingerprint,
      digest: "Original observed finding. ".repeat(140).trim() }],
    continuation: createSuperContinuation("Prior handoff."),
  };
  request.contextCompactionStore!.registerSources([oldSource]);
  request.contextCompactionStore!.commit(previousInput);
  const snapshot = captureRequestContextCompaction(request.contextCompactionStore!);
  const store = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
  const previous = store.get(previousInput.scopeId)!;
  readSavedCheckpoint = () => store.get(previous.scopeId);
  request = deriveTestRequestExecutionScope(request, { contextCompactionStore: store });
  const controller = createModelStepCompactionController(request, {
    call: { roleId: "worker", callId: "worker-1", objective: request.prompt }, sourceRevision: 2,
    scopeId: previous.scopeId, consumer: "worker.result", allowedConsumers: ["worker.result"],
    projectContinuation: projectSuperContinuation,
  }, generateSuperCompactionCandidate);
  const messages = controller.project([
    { role: "system", content: "Fixed task policy ".repeat(options.prefixRepeats ?? 2_450) },
    { role: "user", content: request.prompt },
    { role: "assistant", content: "", toolCalls: [{ callId: "fresh-read", name: "read", arguments: "{}" }] },
    { role: "tool", toolCallId: "fresh-read", toolName: "read", content: "A new observed fact." },
  ]);
  const admission = resolveModelContextAdmission({ runnerConfig: request.runnerConfig,
    agentMode: request.agentMode, modelStep: "worker.result", modelPolicy: request.modelPolicy });
  const { assess } = createModelContextAssessment({ request, params: { modelStep: "worker.result", format: { type: "text" } },
    admission, assertCurrent() {} });
  return { calls, fullCounts, checkpointCounts, measuredCheckpoints, previous, oldSource, store,
    async run() {
      const assessment = await assess(messages);
      expect(requiresContextCompaction(true, assessment)).toBe(true);
      return admitCompactedContext({ messages, assessment, controller, assess,
        assertCurrent() {}, assertNotAborted() {}, abortSignal: request.abortSignal,
        identity: { requestId: request.requestId, invocationId: "retained-full-input",
          modelStep: "worker.result", profileId: "compact-test-profile", provider: "test", model: "compact-test-model" },
      });
    },
  };
}
