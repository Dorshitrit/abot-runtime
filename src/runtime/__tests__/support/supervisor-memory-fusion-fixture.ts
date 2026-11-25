import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { LongTermMemoryService } from "../../long-term-memory/contracts.js";
import type { LearningKnowledgeContext, LearningMemoryService } from "../../long-term-memory/maturation/contracts.js";
import type { ModelGatewayClient } from "../../ports.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { defaultSupervisorPresentation } from "./supervisor-model-phases.js";
import { workerFusedReply } from "./worker-evidence-script.js";

export type MemoryFusionInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const CHILD_FACT = "The delegated comparison established that cobalt is blue.";
export const RAW_ANSWER = "Cobalt is blue.\nThe comparison is complete.";
export const MEMORY_PROPOSAL = {
  content: "The user prefers concise answers.", tags: ["style"], target: "k1", score: 92,
  reason: "The current user confirms this preference.", reinforced: true, explicitRequestQuote: null,
};
export const MEMORY_KNOWLEDGE: LearningKnowledgeContext = {
  kind: "learning_knowledge_reference_v1", authority: "passive_reference",
  presenceEffect: "does_not_authorize_actions_or_add_user_intent",
  repositoryRevision: 2, knowledgeRevision: 3, omitted: 0,
  referenceTime: "2026-11-24T10:00:00.000Z",
  entries: [
    { kind: "candidate", id: "mutable-style", version: "7", content: "Prefers concise answers.",
      tags: ["style"], score: 70, reason: "Prior support.", certainty: "observed", mutable: true,
      lastReinforcedAt: null, reconsiderAt: null },
    { kind: "memory", id: "protected-style", version: "protected-version", content: "A manual preference.",
      tags: [], score: null, reason: null, certainty: "observed", mutable: false,
      lastReinforcedAt: null, reconsiderAt: null },
  ],
};

export function memoryFusionFormat(input: MemoryFusionInput): string | undefined {
  return typeof input.format === "object" && input.format !== null && typeof input.format.name === "string"
    ? input.format.name : undefined;
}

export function memoryFusionCapsules(input: MemoryFusionInput, kind: string) {
  return (input.messages as readonly ChatMessage[]).flatMap(message => {
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      return parsed?.kind === kind ? [parsed] : [];
    } catch { return []; }
  });
}

export function isAfterChildRouting(input: MemoryFusionInput): boolean {
  return input.modelStep === "supervisor.decision" &&
    memoryFusionCapsules(input, "runtime_child_result").length > 0;
}

/** Direct gateway spy: every recorded call is an actual runtime invocation. */
export function createSupervisorMemoryFusionFixture(options: {
  greeting?: boolean;
  candidates?: unknown;
} = {}) {
  const requestSteering = createRequestSteeringInbox({ requestId: "supervisor-memory-fusion" });
  const prepare = vi.fn(async () => structuredClone(MEMORY_KNOWLEDGE));
  const learning: LearningMemoryService = {
    prepare, policy: vi.fn(), configurePolicy: vi.fn(), reviewAdmission: vi.fn(),
    nextReconsiderationAt: vi.fn(), reconsiderationContext: vi.fn(), maintenance: vi.fn(),
    nextExpiryAt: vi.fn(), overview: vi.fn(), sourceVersions: vi.fn(), apply: vi.fn(), list: vi.fn(), receipt: vi.fn(),
  };
  const memory = {
    enabled: true, learning, retrieve: vi.fn(async () => ({ available: true, records: [] })),
    processCandidates: vi.fn(), scheduleCandidates: vi.fn(), status: vi.fn(), list: vi.fn(),
    search: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn(),
  } satisfies LongTermMemoryService;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async input => {
    const format = memoryFusionFormat(input);
    if (format === "supervisor_fused_entry" || format === "supervisor_fused_entry_with_memory_candidates") return { text: JSON.stringify({ decision: {
      requiresProcedure: !options.greeting,
      ...(options.greeting ? { responseRecommendation: "Greet the user briefly." } : {}),
      ...(options.greeting && format === "supervisor_fused_entry_with_memory_candidates"
        ? { memoryCandidates: options.candidates ?? [MEMORY_PROPOSAL] } : {}),
      ...defaultSupervisorPresentation(input),
    } }), meta: {} };
    if (isAfterChildRouting(input)) return { text: JSON.stringify({ decision: {
      action: "respond",
      ...(format === "supervisor_decision_with_memory_candidates"
        ? { memoryCandidates: options.candidates ?? [MEMORY_PROPOSAL] } : {}),
    } }), meta: {} };
    if (format === "supervisor_fused_routing") return { text: JSON.stringify({ decision: {
      action: "invoke_role", roleId: "worker", objective: "Explain the supplied cobalt comparison.",
      workingDirectory: ".", ...defaultSupervisorPresentation(input),
    } }), meta: {} };
    if (input.modelStep === "worker.decision") return workerFusedReply(input, { action: "return_result" });
    if (input.modelStep === "worker.result") return { text: CHILD_FACT, meta: {} };
    if (format === "supervisor_memory_candidates")
      return { text: JSON.stringify({ memoryCandidates: options.candidates ?? [MEMORY_PROPOSAL] }), meta: {} };
    if (input.modelStep === "supervisor.response" && input.format === undefined)
      return { text: RAW_ANSWER, meta: {} };
    throw new Error(`Unexpected memory-fusion fixture invocation: ${input.modelStep}/${format}`);
  });
  const request = createTestRequestExecutionScope({
    requestId: "supervisor-memory-fusion", sessionId: "supervisor-memory-session",
    prompt: options.greeting ? "Hello." : "Compare the supplied cobalt facts. I prefer concise answers.",
    historyMessages: [], shouldGenerateSessionTitle: false, requestSteering,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: Object.fromEntries(["supervisor.decision", "supervisor.response", "worker.decision", "worker.result"]
        .map(step => [step, { timeoutMs: 20_000 }])),
    },
    agentMode: "reasoning", toolPermissionMode: "full_access",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: { test: { provider: "local", model: "test", contextWindowTokens: 32_000 } },
      defaults: { profileId: "test", steps: {
        "supervisor.decision": "supervisor.decision", "supervisor.response": "supervisor.response",
      } },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    longTermMemory: memory, abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  return { request, invoke, memory, prepare, requestSteering };
}
