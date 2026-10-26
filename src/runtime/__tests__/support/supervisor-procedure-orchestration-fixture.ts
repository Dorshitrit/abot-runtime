import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";
import { createRequestExecutionScope } from "../../request/execution-scope.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { supervisorFormatName } from "./supervisor-model-phases.js";

export type ProcedureModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const PROCEDURE_PROMPT = "  Save the preceding summary in report.txt.  ";
export const PROCEDURE_SOURCE = "  Exact prior summary\nsecond line\\nliteral  ";
export const PROCEDURE_OLD_HISTORY = "OLD_UNRELATED_TURN_SENTINEL";
export const PROCEDURE_SKILL = {
  skillId: "procedure-guidance", name: "Procedure guide", description: "Guidance for the current assignment.",
  content: "CAPTURED_PROCEDURE_GUIDANCE_BODY: retain the requested scope.",
};
export const PROCEDURE_CAPABILITIES: readonly WorkerCapabilityDescriptor[] = [
  { capabilityId: "fixture.observe", summary: "Observe a target.", effect: "observation", catalogGroups: ["read"],
    controls: { type: "object", additionalProperties: false, properties: {}, required: [] } },
  { capabilityId: "fixture.update", summary: "Update a target.", effect: "mutation", catalogGroups: ["write"],
    controls: { type: "object", additionalProperties: false, properties: {}, required: [] } },
];

export function procedureMessages(input: ProcedureModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

export function procedureCapsules(input: ProcedureModelInput): readonly Record<string, unknown>[] {
  return procedureMessages(input).flatMap(({ content }) => {
    try {
      const value = JSON.parse(content) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      return [value as Record<string, unknown>];
    } catch { return []; }
  });
}

export function createProcedureOrchestrationFixture(
  decide: (input: ProcedureModelInput) => unknown | Promise<unknown>,
  options: Readonly<{ skills?: boolean }> = {},
) {
  const requestSteering = createRequestSteeringInbox({ requestId: "procedure-orchestration-request" });
  const getAdapters = vi.fn(() => PROCEDURE_CAPABILITIES.map((descriptor) => ({
    descriptor,
    execute: vi.fn(async () => { throw new Error("procedure_fixture_unexpected_capability_execution"); }),
  })));
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_presentation")
      return { text: JSON.stringify({ decision: { acknowledgement: "I will handle the current request." } }), meta: {} };
    if (phase === "supervisor_skill_selection")
      return { text: JSON.stringify({ decision: { action: "read_skills", skillIds: [PROCEDURE_SKILL.skillId] } }), meta: {} };
    const output = await decide(input);
    return { text: typeof output === "string" ? output : JSON.stringify({ decision: output }), meta: {} };
  });
  const request = createTestRequestExecutionScope({
    requestId: "procedure-orchestration-request", sessionId: "procedure-orchestration-session",
    prompt: PROCEDURE_PROMPT, shouldGenerateSessionTitle: false,
    historyMessages: [
      { id: "old-user", role: "user", content: PROCEDURE_OLD_HISTORY, requestId: "old", createdAt: "2026-10-01T00:00:00Z" },
      { id: "old-assistant", role: "assistant", content: "An unrelated old answer.", requestId: "old", createdAt: "2026-10-01T00:00:01Z" },
      { id: "prior-user", role: "user", content: "Prepare the exact summary.", requestId: "prior", createdAt: "2026-10-01T00:00:02Z" },
      { id: "prior-assistant", role: "assistant", content: PROCEDURE_SOURCE, requestId: "prior", createdAt: "2026-10-01T00:00:03Z" },
    ],
    requestSteering,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: Object.fromEntries([
        "supervisor.decision", "supervisor.response", "worker.evidence", "worker.decision", "worker.result", "planner.decision",
      ].map((step) => [step, { timeoutMs: 20_000 }])),
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: { test: { provider: "local", model: "test", contextWindowTokens: 64_000 } },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => PROCEDURE_CAPABILITIES, getAdapters },
    toolPermissionMode: "full_access", abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  const store = {
    list: vi.fn(() => [{ skillId: PROCEDURE_SKILL.skillId, name: PROCEDURE_SKILL.name, description: PROCEDURE_SKILL.description }]),
    read: vi.fn(() => PROCEDURE_SKILL),
  };
  const scoped = options.skills ? createRequestExecutionScope({
    seed: request, executionPolicy: request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => request.workerCapabilities.provider,
  }) : request;
  return { request: scoped, invoke, requestSteering, getAdapters, store };
}
