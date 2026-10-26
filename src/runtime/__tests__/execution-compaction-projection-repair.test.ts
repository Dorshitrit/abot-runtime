import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { createPolicyModelStepCompactionController } from "../context/super-compaction/routing.js";
import { createSessionMemoryAwareCompactionController } from "../context/session-memory/model-step-controller.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionGenerationParams,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import type { ContextCompactionProjectionRepair } from "../model/context-compaction-contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { compactContinuation, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { createRootCompactionFixture } from "./support/root-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const REPAIR: ContextCompactionProjectionRepair = Object.freeze({
  reason: "projection_not_reduced",
  originalInputTokens: 23_756,
  candidateInputTokens: 24_056,
  targetInputTokens: 22_937,
});

/** The public owners, rather than a model-step name, choose eligibility. */
test("EA opts in while shared, SUPER and session-history stages retain their defaults", async () => {
  const ea = await createRootCompactionFixture("execution-agent-v1", { noActiveEvidence: true });
  const active = createExecutionAgentCompactionController(ea.request, {
    call: ea.call,
    head: ea.head,
    steeringSnapshot: { version: 0, updates: [] },
    consumer: "execution.decision",
    allowedConsumers: ["execution.decision", "execution.response"],
  });
  expect(active.getStages()).toEqual([
    expect.objectContaining({ compactionScope: "active_request", supportsProjectionRepair: true }),
  ]);
  const shared = createModelStepCompactionController(ea.request, {
    call: { ...ea.call, objective: ea.request.prompt },
    sourceRevision: ea.head.revision,
    consumer: "execution.decision",
    allowedConsumers: ["execution.decision"],
  });
  expect(shared.getStages()[0]).not.toHaveProperty("supportsProjectionRepair");
  const combined = createSessionMemoryAwareCompactionController(ea.request, active).getStages();
  expect(combined.map(({ compactionScope }) => compactionScope)).toEqual([
    "session_history", "active_request",
  ]);
  expect(combined[0]).not.toHaveProperty("supportsProjectionRepair");
  expect(combined[1]).toBe(active.getStages()[0]);

  const superFixture = await createRootCompactionFixture("supervisor-worker-v1", { noActiveEvidence: true });
  const superController = createPolicyModelStepCompactionController(superFixture.request, {
    call: { ...superFixture.call, objective: superFixture.request.prompt },
    sourceRevision: superFixture.head.revision,
    consumer: "supervisor.decision",
    allowedConsumers: ["supervisor.decision"],
  }, superFixture.request.executionPolicy.authority);
  for (const stage of createSessionMemoryAwareCompactionController(
    superFixture.request, superController,
  ).getStages()) expect(stage).not.toHaveProperty("supportsProjectionRepair");
  expect(ea.invoke).not.toHaveBeenCalled();
  expect(superFixture.invoke).not.toHaveBeenCalled();
});

type EvidenceMode = "fresh" | "previous" | "inherited";

function sourceFromMessage(message: ChatMessage, sourceRef: string): SemanticCompactionSource {
  const content = JSON.stringify(message);
  return { sourceRef, content, sourceFingerprint: hash(content) };
}

function controllerFixture(mode: EvidenceMode) {
  const f = semanticContractFixture({ policy: "execution-agent-v1" });
  const currentScope = "role:supervisor:call-1:continuation";
  const priorScope = mode === "inherited" ? `${currentScope}:prior` : currentScope;
  const priorMessage = {
    role: "tool", content: "Earlier complete canonical observation", toolCallId: "prior-result",
    toolName: "runtime_capability",
  } satisfies ChatMessage;
  const priorSource = sourceFromMessage(priorMessage, "tool-result:prior-result");
  const modelMessage = {
    role: "tool", content: "Current observation", toolCallId: "fresh-result",
    toolName: "runtime_capability",
  } satisfies ChatMessage;
  const canonicalSource = sourceFromMessage({
    ...modelMessage, content: "Current observation with complete canonical provenance",
  }, "tool-result:fresh-result");
  const objective = mode === "inherited" ? `${f.params.request.prompt} Follow the new objective.` : f.params.request.prompt;
  const binding = {
    ...f.params.binding,
    roleId: "supervisor",
    callId: "call-1",
    objectiveFingerprint: hash(objective),
  };
  let previous: SemanticCompactionCheckpoint | undefined;
  if (mode !== "fresh") {
    f.store.registerSources([priorSource]);
    f.store.commit({
      ...binding,
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId: priorScope,
      objectiveFingerprint: hash(f.params.request.prompt),
      sourceRevision: 1,
      sourceDigests: [{
        sourceRef: priorSource.sourceRef, sourceFingerprint: priorSource.sourceFingerprint,
        digest: "Earlier retained observation",
      }],
      continuation: compactContinuation(),
    });
    previous = f.store.get(priorScope)!;
  }
  const generated: SemanticCompactionCheckpoint[] = [];
  const generate = vi.fn(async (params: SemanticCompactionGenerationParams) => {
    f.store.registerSources(params.sources);
    const checkpoint: SemanticCompactionCheckpoint = {
      ...params.binding,
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId: params.scopeId,
      sourceRevision: params.sourceRevision,
      sourceDigests: [
        ...(params.previous?.sourceDigests ?? params.inheritedSourceDigests ?? []),
        ...params.sources.map(({ sourceRef, sourceFingerprint }) => ({
          sourceRef, sourceFingerprint,
          digest: params.projectionRepair ? "Repaired exact observation" : "Rejected verbose observation",
        })),
      ],
      continuation: compactContinuation(),
    };
    generated.push(checkpoint);
    return checkpoint;
  });
  const controller = createModelStepCompactionController(f.params.request, {
    call: { roleId: binding.roleId, callId: binding.callId, objective },
    sourceRevision: 2,
    scopeId: currentScope,
    allowedConsumers: binding.allowedConsumers,
    consumer: "execution.decision",
    supportsProjectionRepair: true,
    resultSourceOverrides: [canonicalSource],
    ...(mode === "inherited" ? { inheritedCheckpoint: previous } : {}),
  }, generate);
  const original = controller.project([
    { role: "system", content: "Existing policy" },
    { role: "user", content: f.params.request.prompt },
    ...(mode === "fresh" ? [] : [priorMessage]),
    modelMessage,
  ]);
  return { ...f, controller, generate, generated, original, previous, canonicalSource, currentScope };
}

test.each<EvidenceMode>(["fresh", "previous", "inherited"])(
  "repair preserves %s evidence bindings and commits only the selected candidate",
  async (mode) => {
    const f = controllerFixture(mode);
    const stage = f.controller.getStages()[0]!;
    const before = captureRequestContextCompaction(f.store);
    const rejected = await stage.prepare(f.original);
    const repaired = await stage.prepare(f.original, { projectionRepair: REPAIR });
    expect(rejected.kind).toBe("prepared");
    expect(repaired.kind).toBe("prepared");
    if (rejected.kind !== "prepared" || repaired.kind !== "prepared") throw new Error("expected_preparations");
    expect(f.generate).toHaveBeenCalledTimes(2);
    const [first, second] = f.generate.mock.calls.map(([params]) => params);
    expect(first!.projectionRepair).toBeUndefined();
    expect(second!.projectionRepair).toBe(REPAIR);
    expect(second!.sources).toEqual([f.canonicalSource]);
    expect(second!.sources).toEqual(first!.sources);
    expect(second!.binding).toEqual(first!.binding);
    expect(second!.sourceRevision).toBe(first!.sourceRevision);
    expect(second!.scopeId).toBe(first!.scopeId);
    expect(second!.previous).toBe(first!.previous);
    expect(second!.inheritedSourceDigests).toBe(first!.inheritedSourceDigests);
    if (mode === "previous") expect(second!.previous).toBe(f.previous);
    if (mode === "inherited") expect(second!.inheritedSourceDigests).toBe(f.previous!.sourceDigests);
    expect(second!.previous).not.toBe(f.generated[0]);
    expect(captureRequestContextCompaction(f.store).checkpoints).toEqual(before.checkpoints);
    expect(repaired.preparation.sourceRevision).toBe(rejected.preparation.sourceRevision);
    expect(repaired.preparation.coveredSourceCount).toBe(rejected.preparation.coveredSourceCount);
    expect(repaired.preparation.hasExhaustedCompactionSources).toBe(true);
    expect(repaired.preparation.messages.filter(({ role }) => role === "tool")).toHaveLength(0);
    expect(repaired.preparation.messages.filter(({ content }) => content === f.params.request.prompt)).toHaveLength(1);
    await repaired.preparation.commit();
    expect(f.store.get(f.currentScope)).toEqual(f.generated[1]);
    expect(f.store.get(f.currentScope)).not.toEqual(f.generated[0]);
    const snapshot = captureRequestContextCompaction(f.store);
    expect(JSON.stringify(snapshot)).not.toContain("projectionRepair");
    const restored = restoreRequestContextCompaction(snapshot);
    expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
    expect(restored.materializeSource(f.canonicalSource.sourceRef, f.canonicalSource.sourceFingerprint)).toEqual(f.canonicalSource);
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
