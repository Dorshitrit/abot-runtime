import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  SESSION_ARTIFACT_PATHS_MESSAGE_KIND,
  type SessionArtifactPathsCapsule,
} from "../context/session-artifact-paths.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { buildSupervisorCapabilityBriefOptions } from "../steps/supervisor-decision/capability-brief.js";
import {
  buildSupervisorDecisionInput,
  runSupervisorDecision,
} from "../steps/supervisor-decision/index.js";
import {
  createTestRequestExecutionScope,
  type TestRequestSeed,
} from "./support/request-execution-scope.js";

const TARGET = ".event_artifacts/news.txt";
const toolResults = { sourceRevision: 1, results: [] };
const catalog = [
  { groupId: "write", memberCount: 1, effects: ["mutation" as const] },
];
const inputOptions = { toolResults, availableWorkerCapabilityCatalog: catalog };

function createRequest(
  overrides: Partial<TestRequestSeed> = {},
  contextWindowTokens = 32_000,
) {
  return createTestRequestExecutionScope({
    requestId: "artifact-path-supervisor-request",
    sessionId: "artifact-path-supervisor-session",
    prompt: "Update the previously saved news summary.",
    historyMessages: [
      {
        id: "prior-user",
        role: "user",
        content: "Save a news summary.",
        createdAt: "2026-10-14T10:00:00.000Z",
        requestId: "prior-request",
      },
      {
        id: "prior-assistant",
        role: "assistant",
        content: "Saved the news summary.",
        createdAt: "2026-10-14T10:00:01.000Z",
        requestId: "prior-request",
      },
    ],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: { "supervisor.decision": { timeoutMs: 1_000 } },
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke: vi.fn(), invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
    ...overrides,
  });
}

function isArtifactPathsMessage(message: ChatMessage): boolean {
  if (message.role !== "system") return false;
  try {
    return (
      JSON.parse(message.content).kind === SESSION_ARTIFACT_PATHS_MESSAGE_KIND
    );
  } catch {
    return false;
  }
}

function withoutArtifactPaths(messages: readonly ChatMessage[]) {
  return messages.filter((message) => !isArtifactPathsMessage(message));
}

function artifactCapsules(messages: readonly ChatMessage[]) {
  return messages
    .filter(isArtifactPathsMessage)
    .map(({ content }) => JSON.parse(content) as SessionArtifactPathsCapsule);
}

async function runDelegation(
  options: {
    sessionArtifactPaths?: readonly string[];
    prompt?: string;
    objective?: string;
    workingDirectory?: string;
  } = {},
) {
  const objective = options.objective ?? "Update the existing news summary.";
  const workingDirectory = options.workingDirectory ?? ".event_artifacts";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
    text:
      typeof input.format === "object" &&
      input.format?.name === "supervisor_decision"
        ? JSON.stringify({
            decision: { action: "invoke_role", roleId: "planner", objective },
          })
        : JSON.stringify({ workingDirectory }),
    meta: {},
  }));
  const request = createRequest({
    ...(options.sessionArtifactPaths
      ? { sessionArtifactPaths: options.sessionArtifactPaths }
      : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
  });
  const outcome = await runSupervisorDecision(request, {
    call: {
      rootCallId: "call-1",
      callId: "call-1",
      parentCallId: null,
      depth: 0,
      invocationAttempt: 1,
    },
    toolResults,
    allowedRoleIds: ["planner"],
  });
  return {
    request,
    outcome,
    inputs: invoke.mock.calls.map(([input]) => ({
      messages: input.messages as readonly ChatMessage[],
      format: input.format,
    })),
  };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Supervisor session artifact path reference", () => {
  test("keeps absent and empty registries identical through both existing phases", async () => {
    const absent = await runDelegation();
    const empty = await runDelegation({ sessionArtifactPaths: [] });
    expect(empty.outcome).toEqual(absent.outcome);
    expect(
      empty.inputs.map(({ messages, format }) => ({ messages, format })),
    ).toEqual(
      absent.inputs.map(({ messages, format }) => ({ messages, format })),
    );
    expect(empty.inputs).toHaveLength(2);
    for (const input of empty.inputs)
      expect(artifactCapsules(input.messages)).toEqual([]);
  });

  test("adds one bounded passive reference without replacing history, catalog or user intent", () => {
    const baseline = buildSupervisorDecisionInput(
      createRequest(),
      inputOptions,
    );
    const targets = [
      TARGET,
      ...Array.from({ length: 9 }, (_, index) => `other-${index}.txt`),
    ];
    const request = createRequest({ sessionArtifactPaths: targets });
    const projected = buildSupervisorDecisionInput(request, inputOptions);
    const capsules = artifactCapsules(projected.context.messages);
    expect(capsules).toHaveLength(1);
    expect(capsules[0]).toMatchObject({
      authority: "canonical_runtime_state",
      applicability:
        "supervisor_objective_and_working_directory_reference_only",
      targets: targets.slice(0, 8),
      nonAuthority: {
        addsUserIntent: false,
        addsPendingWork: false,
        choosesOrRedirectsTarget: false,
        provesTargetExists: false,
        provesCompletion: false,
      },
      omission: {
        availableTargetCount: 10,
        projectedTargetCount: 8,
        omittedTargetCount: 2,
      },
    });
    expect(projected.context.messages[0]?.role).toBe("system");
    expect(withoutArtifactPaths(projected.context.messages).slice(1)).toEqual(
      baseline.context.messages.slice(1),
    );
    expect(projected.context.selectedHistoryMessageIds).toEqual(
      baseline.context.selectedHistoryMessageIds,
    );
    expect(projected.context.messages.filter(isCapabilityBriefMessage)).toEqual(
      baseline.context.messages.filter(isCapabilityBriefMessage),
    );
    expect(
      projected.context.messages.filter(
        ({ role, content }) => role === "user" && content === request.prompt,
      ),
    ).toHaveLength(1);
    expect(projected.format).toEqual(baseline.format);
    expect(projected.availableWorkerCapabilityCatalog).toEqual(
      baseline.availableWorkerCapabilityCatalog,
    );
  });

  test("passes the exact dotted target once to routing and inherited directory selection with no extra invocation", async () => {
    const result = await runDelegation({ sessionArtifactPaths: [TARGET] });
    expect(
      result.inputs.map(
        ({ format }) => typeof format === "object" && format?.name,
      ),
    ).toEqual(["supervisor_decision", "supervisor_working_directory"]);
    for (const input of result.inputs) {
      expect(artifactCapsules(input.messages)).toHaveLength(1);
      expect(artifactCapsules(input.messages)[0]?.targets).toEqual([TARGET]);
      expect(
        input.messages.filter(
          ({ role, content }) =>
            role === "user" && content === result.request.prompt,
        ),
      ).toHaveLength(1);
    }
    expect(result.outcome).toMatchObject({
      decision: { roleId: "planner", workingDirectory: ".event_artifacts" },
      steeringVersion: 0,
    });
  });

  test("preserves an explicit new objective and selected directory alongside the old reference", async () => {
    const objective = "Write a new summary in new-project/news.txt.";
    const result = await runDelegation({
      sessionArtifactPaths: [TARGET],
      prompt: objective,
      objective,
      workingDirectory: "new-project",
    });
    expect(result.outcome).toEqual({
      decision: {
        action: "invoke_role",
        roleId: "planner",
        objective,
        workingDirectory: "new-project",
      },
      steeringVersion: 0,
    });
    expect(artifactCapsules(result.inputs[1]!.messages)[0]?.targets).toEqual([
      TARGET,
    ]);
    expect(result.inputs).toHaveLength(2);
  });

  test("omits the optional paths near the compaction threshold without evicting history or catalog", () => {
    const ample = buildSupervisorDecisionInput(createRequest(), inputOptions);
    const contextWindowTokens = Math.ceil(
      (ample.context.budget.estimatedInputTokens + 20) / 0.7,
    );
    const baseline = buildSupervisorDecisionInput(
      createRequest({}, contextWindowTokens),
      inputOptions,
    );
    const projected = buildSupervisorDecisionInput(
      createRequest({ sessionArtifactPaths: [TARGET] }, contextWindowTokens),
      inputOptions,
    );
    expect(baseline.context.budget.estimatedInputTokens).toBeLessThan(
      baseline.context.budget.compactionTriggerInputTokens,
    );
    expect(
      baseline.context.messages.filter(isCapabilityBriefMessage),
    ).toHaveLength(1);
    expect(baseline.context.selectedHistoryMessageIds).toEqual([
      "prior-user",
      "prior-assistant",
    ]);
    expect(artifactCapsules(projected.context.messages)).toEqual([]);
    expect(projected.context).toEqual(baseline.context);
    expect(projected.format).toEqual(baseline.format);
  });

  test.each(["calibration", "steering"] as const)(
    "reserves %s without a Worker catalog when admitting Planner references",
    (kind) => {
      const base = createRequest();
      const pendingText = "p".repeat(100_000);
      const steering = createRequestSteeringInbox({
        requestId: base.requestId,
      });
      if (kind === "steering") {
        expect(
          steering.append({ steerId: "new-steering", text: pendingText }).ok,
        ).toBe(true);
      }
      const request = createRequest({
        sessionArtifactPaths: [TARGET],
        requestSteering: steering,
        modelPolicy: {
          ...base.modelPolicy,
          defaults: {
            profileId: "test",
            steps: { "supervisor.decision": "supervisor.decision" },
          },
          profiles: {
            test: {
              ...base.modelPolicy!.profiles!.test!,
              ...(kind === "calibration"
                ? {
                    calibration: {
                      "supervisor.decision": { instructions: [pendingText] },
                    },
                  }
                : {}),
            },
          },
        },
      });
      const roleOptions = { allowedRoleIds: ["planner"] as const };
      const reserved = buildSupervisorCapabilityBriefOptions(
        request,
        roleOptions,
      );
      expect(reserved.capabilityBriefEntries).toBeUndefined();
      expect(
        reserved.capabilityBriefBudgetMessages?.some(({ content }) =>
          content.includes(pendingText),
        ),
      ).toBe(true);
      const unreserved = buildSupervisorDecisionInput(request, {
        toolResults,
        ...roleOptions,
      });
      const projected = buildSupervisorDecisionInput(request, {
        toolResults,
        ...roleOptions,
        ...reserved,
      });
      expect(artifactCapsules(unreserved.context.messages)).toHaveLength(1);
      expect(artifactCapsules(projected.context.messages)).toEqual([]);
      expect(projected.availableWorkerCapabilityCatalog).toEqual([]);
      expect(projected.context.selectedHistoryMessageIds).toEqual(
        unreserved.context.selectedHistoryMessageIds,
      );
      expect(projected.format).toEqual(unreserved.format);
      expect(request.modelGatewayClient.invoke).not.toHaveBeenCalled();
    },
  );

  test("counts additional pending messages when admitting the optional reference", () => {
    const request = createRequest({ sessionArtifactPaths: [TARGET] });
    const options = {
      ...inputOptions,
      capabilityBriefBudgetMessages: [
        { role: "system" as const, content: "x".repeat(100_000) },
      ],
    };
    const baseline = buildSupervisorDecisionInput(createRequest(), options);
    const projected = buildSupervisorDecisionInput(request, options);
    expect(artifactCapsules(projected.context.messages)).toEqual([]);
    expect(projected.context).toEqual(baseline.context);
  });
});
