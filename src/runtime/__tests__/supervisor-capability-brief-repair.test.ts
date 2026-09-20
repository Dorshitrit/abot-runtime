import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/index.js";
import type { ModelGatewayClient } from "../ports.js";
import { buildSupervisorCapabilityBriefOptions } from "../steps/supervisor-decision/capability-brief.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { runSupervisorDecision } from "../steps/supervisor-decision/run.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
const prompt = "Inspect the requested record.";
const entries: ToolAvailabilityEntry[] = Array.from({ length: 40 }, (_, i) => ({
  toolName: `tool_${i}`,
  operationId: `observe_${i}`,
  summary: `Observe record ${i}. ${"f".repeat(300)}`,
  catalogGroups: ["read"],
  effect: "read_only",
}));
const descriptors: WorkerCapabilityDescriptor[] = entries.map((entry) => ({
  capabilityId: entry.operationId,
  summary: entry.summary,
  effect: "observation",
  catalogGroups: entry.catalogGroups,
  controls: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
}));
const catalog = [
  {
    groupId: "read",
    memberCount: entries.length,
    effects: ["observation" as const],
  },
];
const call = {
  rootCallId: "call-1",
  callId: "call-1",
  parentCallId: null,
  depth: 0,
  invocationAttempt: 1,
};
const toolResults = { sourceRevision: 1, results: [] };

function formatName(input: ModelInput): string | undefined {
  const format = input.format;
  if (typeof format !== "object" || format === null) return undefined;
  return typeof format.name === "string" ? format.name : undefined;
}

function createHarness(hasCatalog = true) {
  const events: { name: string; extra?: Record<string, unknown> }[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (formatName(input) === "supervisor_working_directory") {
      return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
    }
    const attempt = invoke.mock.calls.length;
    if (attempt <= 2) return { text: "{", meta: {} };
    return {
      text: JSON.stringify({
        decision: {
          action: "invoke_role",
          roleId: "worker",
          objective: prompt,
          ...(hasCatalog
            ? { workerCapabilityScope: { catalogGroupIds: ["read"] } }
            : {}),
        },
      }),
      meta: {},
    };
  });
  function request(contextWindowTokens: number) {
    return createTestRequestExecutionScopeWithCapabilities(
      {
        requestId: "pr78-repair-admission",
        sessionId: "pr78-repair-admission",
        prompt,
        historyMessages: [],
        shouldGenerateSessionTitle: false,
        runnerConfig: {
          models: { defaults: { profileId: "test", steps: {} } },
          context: {
            outputReserveTokens: 100,
            safetyReserveTokens: 20,
            attachmentReserveTokens: 0,
          },
          steps: {
            "supervisor.decision": { timeoutMs: 1000 },
            "context.compact": { timeoutMs: 1000 },
          },
        },
        agentMode: "reasoning",
        modelPolicy: {
          providers: { local: { type: "ollama" } },
          profiles: {
            test: {
              provider: "local",
              model: "test",
              contextWindowTokens,
              context: { formatTokenAccounting: { mode: "none" } },
            },
          },
          defaults: { profileId: "test", steps: {} },
        },
        modelGatewayClient: { invoke, invokeRaw: vi.fn() },
        toolPermissionMode: "full_access",
        abortSignal: new AbortController().signal,
        onAcknowledgement: vi.fn(),
        onSessionTitle: vi.fn(async () => {}),
        onThinkingDelta: vi.fn(),
        onThinkingTrace: vi.fn(),
        onAnswerToken: vi.fn(),
        onEvent: (name, extra) => {
          events.push({ name, extra });
        },
      },
      () => ({
        getDescriptors: () => (hasCatalog ? descriptors : []),
        getAdapters: () => [],
        getAvailableTools: () => (hasCatalog ? entries : []),
      }),
    );
  }
  const options = {
    call,
    toolResults,
    allowedRoleIds: ["worker" as const],
    availableWorkerCapabilityCatalog: hasCatalog ? catalog : [],
  };
  function projected(contextWindowTokens: number) {
    const scope = request(contextWindowTokens);
    return buildSupervisorDecisionInput(scope, {
      ...options,
      ...buildSupervisorCapabilityBriefOptions(scope, options),
    });
  }
  return { invoke, events, request, options, projected };
}

function messages(input: ModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

function nonBrief(input: ModelInput): readonly ChatMessage[] {
  return messages(input).filter(
    (message) => !isCapabilityBriefMessage(message),
  );
}

function assertRepairIsolation(inputs: readonly ModelInput[]) {
  const original = nonBrief(inputs[0]!);
  for (const input of inputs.slice(1, 3)) {
    const repaired = nonBrief(input);
    expect(repaired.slice(0, -1)).toEqual(original);
    expect(repaired).toHaveLength(original.length + 1);
    expect(repaired.at(-1)?.role).toBe("system");
    expect(input.format).toEqual(inputs[0]!.format);
  }
  expect(nonBrief(inputs[1]!).at(-1)).not.toEqual(nonBrief(inputs[2]!).at(-1));
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Supervisor optional descriptions across structured repairs", () => {
  test("reselects an optional brief before both repair admissions on a fresh near-threshold request", async () => {
    const harness = createHarness();
    const initial = harness.projected(32000).context.budget;
    const capacity = Math.ceil(
      (initial.estimatedInputTokens + initial.formatReserveTokens + 2) / 0.7,
    );
    const projection = harness.projected(capacity);
    expect(
      projection.context.messages.find(isCapabilityBriefMessage)?.content,
    ).toContain("Detail: descriptions.");
    const request = harness.request(capacity);
    await expect(
      runSupervisorDecision(request, harness.options),
    ).resolves.toEqual({
      decision: {
        action: "invoke_role",
        roleId: "worker",
        objective: prompt,
        workingDirectory: ".",
        workerCapabilityScope: { catalogGroupIds: ["read"] },
      },
      steeringVersion: 0,
    });
    expect(harness.invoke).toHaveBeenCalledTimes(4);
    const inputs = harness.invoke.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => formatName(input))).toEqual([
      "supervisor_decision",
      "supervisor_decision",
      "supervisor_decision",
      "supervisor_working_directory",
    ]);
    const firstBrief = messages(inputs[0]!).find(isCapabilityBriefMessage)!;
    expect(JSON.parse(firstBrief.content.split("\n").at(-1)!)).toHaveLength(40);
    for (const input of inputs.slice(1, 3)) {
      const brief = messages(input).find(isCapabilityBriefMessage);
      if (brief) {
        expect(brief.content).not.toContain("Detail: descriptions.");
        expect(brief.content).not.toContain(entries[0]!.summary);
        expect(brief.content).not.toContain(entries.at(-1)!.summary);
        if (brief.content.includes("Detail: detailed.")) {
          for (const entry of entries)
            expect(brief.content).toContain(entry.operationId);
        } else if (brief.content.includes("Detail: titles.")) {
          for (const entry of entries)
            expect(brief.content).toContain(entry.toolName);
        } else {
          expect(brief.content).toContain("Detail: groups.");
          expect(brief.content).toContain("memberCount=40");
        }
      }
    }
    expect(messages(inputs[3]!).filter(isCapabilityBriefMessage)).toEqual([]);
    assertRepairIsolation(inputs);
    expect(
      harness.events.filter(({ name }) =>
        name.startsWith("context.compaction."),
      ),
    ).toEqual([]);
    const admitted = harness.events
      .filter(({ name }) => name === "context.window.snapshot")
      .map(({ extra }) => extra!);
    expect(admitted).toHaveLength(4);
    for (const snapshot of admitted)
      expect(snapshot.estimatedInputTokens).toBeLessThan(
        Number(snapshot.compactionTriggerInputTokens),
      );
  });

  test("retains complete descriptions when both repair hints still fit", async () => {
    const harness = createHarness();
    await runSupervisorDecision(harness.request(32000), harness.options);
    const inputs = harness.invoke.mock.calls.map(([input]) => input);
    expect(inputs).toHaveLength(4);
    const brief = messages(inputs[0]!).find(isCapabilityBriefMessage);
    expect(brief?.content).toContain("Detail: descriptions.");
    for (const input of inputs.slice(1, 3))
      expect(messages(input).find(isCapabilityBriefMessage)).toEqual(brief);
    assertRepairIsolation(inputs);
    expect(
      harness.events.filter(({ name }) =>
        name.startsWith("context.compaction."),
      ),
    ).toEqual([]);
  });

  test("preserves ordinary no-catalog repair and working-directory handoff", async () => {
    const harness = createHarness(false);
    await expect(
      runSupervisorDecision(harness.request(32000), harness.options),
    ).resolves.toEqual({
      decision: {
        action: "invoke_role",
        roleId: "worker",
        objective: prompt,
        workingDirectory: ".",
      },
      steeringVersion: 0,
    });
    const inputs = harness.invoke.mock.calls.map(([input]) => input);
    expect(inputs).toHaveLength(4);
    for (const input of inputs)
      expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
    assertRepairIsolation(inputs);
    expect(
      harness.events.filter(({ name }) =>
        name.startsWith("context.compaction."),
      ),
    ).toEqual([]);
  });
});
