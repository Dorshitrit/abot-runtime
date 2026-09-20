import { vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../../capabilities/tool-types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { buildPlannerDecisionInput } from "../../steps/planner-decision/input.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export const PLANNER_BRIEF_ENTRIES: readonly ToolAvailabilityEntry[] =
  Array.from({ length: 6 }, (_, index) => ({
    toolName: `fixture_tool_${index}`,
    operationId: `fixture_operation_${index}`,
    summary: `Canonical observation ${index}. ${"Read bounded existing content. ".repeat(20)}`,
    catalogGroups: ["read"],
    effect: "read_only",
  }));

export const PLANNER_BRIEF_CALL: RoleCallFrame = Object.freeze({
  callId: "call-2",
  parentCallId: "call-1",
  roleId: "planner",
  depth: 1,
  objective: "Inspect the existing artifact and preserve its exact scope.",
  workingDirectory: "project",
  dependencyResultRefs: [],
  status: "active",
  childCallIds: [],
  activationCount: 1,
  resultRef: null,
});

export function createPlannerBriefFixture(
  options: {
    entries?: readonly ToolAvailabilityEntry[];
    metadataAvailable?: boolean;
    workerAvailable?: boolean;
    contextWindowTokens?: number;
    methodology?: string;
    calibration?: string;
  } = {},
) {
  const entries = options.entries ?? PLANNER_BRIEF_ENTRIES;
  const steering = createRequestSteeringInbox({ requestId: "planner-brief" });
  const invoke = vi.fn(
    async (_input: Parameters<ModelGatewayClient["invoke"]>[0]) => ({
      text: JSON.stringify({
        decision: {
          action: "return_failure",
          reason: "Bounded fixture result.",
        },
      }),
      meta: {},
    }),
  );
  const request = createTestRequestExecutionScope({
    requestId: "planner-brief",
    sessionId: "planner-brief-session",
    prompt: "Inspect project/EXACT_TARGET without changing unrelated content.",
    historyMessages: [
      {
        id: "prior",
        role: "user",
        content: "UNRELATED_HISTORY",
        createdAt: "2026-09-20T00:00:00Z",
      },
    ],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    requestSteering: steering,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    runnerConfig: {
      models: { defaults: { profileId: "fixture", steps: {} } },
      context: {
        outputReserveTokens: 100,
        safetyReserveTokens: 20,
        attachmentReserveTokens: 20,
      },
      steps: {
        "planner.decision": {
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
          contextWindowTokens: options.contextWindowTokens ?? 32_000,
          context: {
            tokenEstimation: {
              asciiCharactersPerToken: 1,
              nonAsciiBytesPerToken: 1,
              messageOverheadTokens: 1,
            },
            formatTokenAccounting: { mode: "none" },
          },
          calibration: {
            "planner.decision": {
              ...(options.calibration
                ? { instructions: [options.calibration] }
                : {}),
            },
          },
        },
      },
      defaults: {
        profileId: "fixture",
        steps: { "planner.decision": "planner.decision" },
      },
    },
    workerCapabilityProvider: {
      ...(options.metadataAvailable === false
        ? {}
        : { getAvailableTools: () => entries }),
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
    },
  });
  const inputOptions = {
    call: PLANNER_BRIEF_CALL,
    availableChildRoleIds:
      options.workerAvailable === false ? [] : (["worker"] as const),
    toolResults: { sourceRevision: 0, results: [] },
  };
  return {
    request,
    inputOptions,
    entries,
    invoke,
    steering,
    input: buildPlannerDecisionInput(request, inputOptions),
  };
}
