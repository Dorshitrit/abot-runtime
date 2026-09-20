import { vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../../capabilities/tool-types.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { projectCapabilityBrief } from "../../context/capability-brief.js";
import { assessRequestMessagesBudget } from "../../context/request-context-budget.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createSupervisorCapabilityBriefReadmissionController } from "../../steps/supervisor-decision/capability-brief-readmission.js";
import { createSupervisorDecisionFormat } from "../../steps/supervisor-decision/format.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./request-execution-scope.js";

const entries: readonly ToolAvailabilityEntry[] = Array.from(
  { length: 6 },
  (_, index) => ({
    toolName: `fixture_${index}`,
    operationId: `operation_${index}`,
    summary: `Canonical operation ${index}. ${"description ".repeat(12)}`,
    catalogGroups: ["read"],
    effect: "read_only",
  }),
);
const groups: readonly WorkerCapabilityCatalogGroup[] = [
  { groupId: "read", memberCount: entries.length, effects: ["observation"] },
];

export function createReadmissionFixture(
  options: {
    contextWindowTokens?: number;
    methodology?: string;
    calibration?: string;
  } = {},
) {
  const steering = createRequestSteeringInbox({
    requestId: "brief-readmission",
  });
  const gateway = {
    invoke: vi.fn(async () => {
      throw new Error("Unexpected model call");
    }),
    invokeRaw: vi.fn(async () => {
      throw new Error("Unexpected raw model call");
    }),
  };
  const request = createTestRequestExecutionScopeWithCapabilities(
    {
      requestId: "brief-readmission",
      sessionId: "fixture-session",
      prompt: "Keep the requested outcome unchanged.",
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      agentMode: "reasoning",
      modelGatewayClient: gateway,
      requestSteering: steering,
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
      runnerConfig: {
        models: { defaults: { profileId: "fixture", steps: {} } },
        context: {
          outputReserveTokens: 100,
          safetyReserveTokens: 20,
          attachmentReserveTokens: 20,
        },
        steps: {
          "supervisor.decision": {
            timeoutMs: 1000,
            ...(options.methodology
              ? {
                  instructionBlocks: [
                    {
                      ref: "fixture-methodology",
                      content: options.methodology,
                      contentHash: "fixture-hash",
                    },
                  ],
                }
              : {}),
          },
        },
      },
      modelPolicy: {
        providers: { fixture: { type: "ollama" } },
        profiles: {
          fixture: {
            provider: "fixture",
            model: "no-live-model",
            contextWindowTokens: options.contextWindowTokens ?? 16_000,
            context: {
              tokenEstimation: {
                asciiCharactersPerToken: 1,
                nonAsciiBytesPerToken: 1,
                messageOverheadTokens: 1,
              },
            },
            ...(options.calibration
              ? {
                  calibration: {
                    "supervisor.decision": {
                      instructions: [options.calibration],
                    },
                  },
                }
              : {}),
          },
        },
        defaults: {
          profileId: "fixture",
          steps: { "supervisor.decision": "supervisor.decision" },
        },
      },
    },
    () => ({
      getAvailableTools: () => entries,
      getDescriptors: () =>
        entries.map((entry) => ({
          capabilityId: entry.operationId,
          summary: entry.summary,
          effect: "observation" as const,
          catalogGroups: entry.catalogGroups,
          controls: {
            type: "object" as const,
            properties: {},
            required: [],
            additionalProperties: false,
          },
        })),
      getAdapters: () => [],
    }),
  );
  const input = {
    format: createSupervisorDecisionFormat({
      availableWorkerCapabilityCatalog: groups,
    }),
    allowedRoleIds: ["worker"] as const,
    availableWorkerCapabilityCatalog: groups,
  };
  const { budget } = resolveModelContextAdmission({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: "supervisor.decision",
    modelPolicy: request.modelPolicy,
    requestFormat: input.format,
  });
  const brief = projectCapabilityBrief({
    entries,
    groups,
    context: {
      instructions: "",
      prompt: "",
      historyMessages: [],
      format: input.format,
      budget: { ...budget, contextWindowTokens: 100_000 },
    },
  }).message!;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Routing contract. ${options.methodology ?? ""}`,
    },
    { role: "user", content: "Previous user instruction." },
    { role: "assistant", content: "Previous answer." },
    brief,
    {
      role: "system",
      content: '{"kind":"fixture_reference","authority":"passive_reference"}',
    },
    { role: "user", content: request.prompt },
  ];
  let scope: ModelStepContextCompactionController["compactionScope"] =
    "session_history";
  const receipt = {
    messages: [{ role: "system" as const, content: "Committed checkpoint" }],
    commit: vi.fn(() => {
      scope = "active_request";
    }),
    scopeId: "fixture-checkpoint",
    sourceRevision: 7,
    coveredSourceCount: 2,
  };
  const project = vi.fn((current: readonly ChatMessage[]) => [...current]);
  const prepare = vi.fn(async (_current: readonly ChatMessage[]) => receipt);
  const controller = {
    get compactionScope() {
      return scope;
    },
    project,
    prepare,
  } satisfies ModelStepContextCompactionController;
  const wrapped = createSupervisorCapabilityBriefReadmissionController(
    request,
    { input, controller },
  );
  const assess = (current: readonly ChatMessage[]) =>
    assessRequestMessagesBudget({
      messages: current,
      budget,
      format: input.format,
    }).budget;
  return {
    request,
    steering,
    input,
    brief,
    messages,
    project,
    prepare,
    receipt,
    wrapped,
    assess,
    gateway,
  };
}
