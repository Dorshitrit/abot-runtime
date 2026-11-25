import { defaultSupervisorPresentation } from "./support/supervisor-model-phases.js";
import { readOpeningRepairInstruction } from "./support/repair-attempt-instruction.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/index.js";
import type { ModelGatewayClient } from "../ports.js";
import { buildSupervisorCapabilityBriefOptions } from "../steps/supervisor-decision/capability-brief.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { runSupervisorDecision } from "../steps/supervisor-decision/run.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
const prompt = "Inspect the requested record.";
const entries: ToolAvailabilityEntry[] = Array.from({ length: 40 }, (_, i) => ({
  toolName: `tool_${i}`,
  pluginName: `plugin_${i}`,
  pluginDescription: `Inspect source ${i}. ${"Read bounded records. ".repeat(4)}`.trim(),
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
const toolResults = { sourceRevision: 1, results: [{
  executionId: "observation-1", callId: "call-1", invocationAttempt: 1,
  capabilityId: "observe_0", declaredEffect: "observation" as const,
  outcome: "succeeded" as const, observedEffect: "none" as const,
  summary: "The first bounded observation settled.",
}] };

function formatName(input: ModelInput): string | undefined {
  const format = input.format;
  if (typeof format !== "object" || format === null) return undefined;
  return typeof format.name === "string" ? format.name : undefined;
}

function createHarness(hasCatalog = true, initialDelegation = false) {
  const events: { name: string; extra?: Record<string, unknown> }[] = [];
  let routingAttempts = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (formatName(input) === "supervisor_fused_entry") {
      return { text: JSON.stringify({ decision: { requiresProcedure: true, ...defaultSupervisorPresentation(input) } }), meta: {} };
    }
    if (formatName(input) === "supervisor_working_directory") {
      return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
    }
    const attempt = ++routingAttempts;
    if (attempt <= 2) return { text: "{", meta: {} };
    return {
      text: JSON.stringify({
        decision: {
          action: "invoke_role",
          roleId: "worker",
          objective: prompt,
          ...(initialDelegation ? { workingDirectory: "." } : {}),
          ...(hasCatalog
            ? { workerCapabilityScope: { catalogGroupIds: ["read"] } }
            : {}),
        },
      }),
      meta: {},
    };
  });
  function request(contextWindowTokens: number, countInputTokens?: ModelGatewayClient["countInputTokens"]) {
    return createTestRequestExecutionScopeWithCapabilities(
      {
        requestId: "pr78-repair-admission",
        sessionId: "pr78-repair-admission",
        prompt,
        historyMessages: initialDelegation ? [
          { id: "prior-user", role: "user", content: "Keep the exact record.", requestId: "prior", createdAt: "2026-11-21T10:00:00Z" },
          { id: "prior-assistant", role: "assistant", content: "  Exact record 🙂\nsecond line\\nliteral  ", requestId: "prior", createdAt: "2026-11-21T10:00:01Z" },
        ] : [],
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
        modelGatewayClient: { invoke, invokeRaw: vi.fn(), ...(countInputTokens ? { countInputTokens } : {}) },
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
    toolResults: initialDelegation ? { sourceRevision: 1, results: [] } : toolResults,
    allowedRoleIds: ["worker" as const],
    availableWorkerCapabilityCatalog: hasCatalog ? catalog : [],
  };
  function projected(contextWindowTokens: number) {
    const scope = request(contextWindowTokens);
    const buildInput = initialDelegation ? buildSupervisorDelegationInput : buildSupervisorDecisionInput;
    return buildInput(scope, {
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
    const repair = readOpeningRepairInstruction(repaired);
    expect(repaired.filter((message) => message !== repair)).toEqual(original);
    expect(repaired).toHaveLength(original.length + 1);
    expect(input.format).toEqual(inputs[0]!.format);
  }
  expect(readOpeningRepairInstruction(nonBrief(inputs[1]!))).not.toEqual(readOpeningRepairInstruction(nonBrief(inputs[2]!)));
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([19_000, 33_000])("exact delegation repair with %i mandatory provider tokens drops only the optional brief", async (mandatoryRepairTokens) => {
  const harness = createHarness(true, true);
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const invocation = resolveModelInvocation(input);
    const delegation = formatName(input) === "supervisor_fused_routing";
    const repair = delegation && harness.invoke.mock.calls.some(([attempt]) => formatName(attempt) === "supervisor_fused_routing");
    return {
      inputTokens: (repair ? mandatoryRepairTokens : 1_000)
        + (messages(input).some(isCapabilityBriefMessage) ? 15_000 : 0),
      profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const run = runSupervisorDecision(harness.request(32_000, countInputTokens), harness.options);
  if (mandatoryRepairTokens > 32_000) {
    await expect(run).rejects.toThrow("request_context_final_envelope_exceeds_window");
    expect(harness.invoke.mock.calls.filter(([input]) => formatName(input) === "supervisor_fused_routing")).toHaveLength(1);
  } else {
    await expect(run).resolves.toMatchObject({ decision: { roleId: "worker", workerCapabilityScope: { catalogGroupIds: ["read"] } } });
    const inputs = harness.invoke.mock.calls.map(([input]) => input)
      .filter(input => formatName(input) === "supervisor_fused_routing");
    expect(inputs).toHaveLength(3);
    expect(messages(inputs[0]!).filter(isCapabilityBriefMessage)).toHaveLength(1);
    for (const input of inputs.slice(1)) expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
    assertRepairIsolation(inputs);
  }
  const counts = countInputTokens.mock.calls.map(([input]) => input)
    .filter(input => formatName(input) === "supervisor_fused_routing");
  // Both candidates retain the same mandatory messages, including exact history and repair.
  expect(nonBrief(counts[2]!)).toEqual(nonBrief(counts[1]!));
  expect(messages(counts[1]!).filter(isCapabilityBriefMessage)).toHaveLength(1);
  expect(messages(counts[2]!).filter(isCapabilityBriefMessage)).toEqual([]);
  expect(harness.events.filter(({ name }) => name.startsWith("context.compaction."))).toEqual([]);
});

describe.each([false, true])("Supervisor optional descriptions across structured repairs (initial delegation: %s)", (initialDelegation) => {
  test("yields the optional brief before both repairs near the admission threshold", async () => {
    const harness = createHarness(true, initialDelegation);
    const initial = harness.projected(32000).context.budget;
    // Measure the actual fused envelope, including its contract and directory scope.
    // The boundary remains two tokens above admission before the repair is added.
    let initialInputTokens = initial.estimatedInputTokens + initial.formatReserveTokens;
    if (initialDelegation) {
      const baseline = createHarness(true, true);
      await runSupervisorDecision(baseline.request(32000), baseline.options);
      const routingSnapshot = baseline.events.filter(({ name }) => name === "context.window.snapshot")[1]!.extra!;
      initialInputTokens = Number(routingSnapshot.estimatedInputTokens);
    }
    const capacity = Math.ceil(
      (initialInputTokens + 2) / 0.7,
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
    const inputs = harness.invoke.mock.calls.map(([input]) => input)
      .filter(input => formatName(input) !== "supervisor_fused_entry");
    const routingFormat = initialDelegation ? "supervisor_fused_routing" : "supervisor_decision";
    expect(inputs.map((input) => formatName(input))).toEqual([
      routingFormat,
      routingFormat,
      routingFormat,
      ...(initialDelegation ? [] : ["supervisor_working_directory"]),
    ]);
    const firstBrief = messages(inputs[0]!).find(isCapabilityBriefMessage)!;
    expect(firstBrief.content.split("\n").at(-1)!.split(" | ")).toHaveLength(40);
    for (const input of inputs.slice(1, 3)) {
      const brief = messages(input).find(isCapabilityBriefMessage);
      if (brief) {
        expect(brief.content).not.toContain("Detail: descriptions.");
        expect(brief.content).not.toContain(entries[0]!.summary);
        expect(brief.content).not.toContain(entries.at(-1)!.summary);
        expect(brief.content).toContain("Detail: groups.");
        expect(brief.content).toContain("memberCount=40");
        for (const entry of entries)
          expect(brief.content).not.toContain(entry.operationId);
      }
    }
    if (!initialDelegation) expect(messages(inputs[3]!).filter(isCapabilityBriefMessage)).toEqual([]);
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
    const harness = createHarness(true, initialDelegation);
    await runSupervisorDecision(harness.request(32000), harness.options);
    const inputs = harness.invoke.mock.calls.map(([input]) => input)
      .filter(input => formatName(input) !== "supervisor_fused_entry");
    expect(inputs).toHaveLength(initialDelegation ? 3 : 4);
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
    const harness = createHarness(false, initialDelegation);
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
    const inputs = harness.invoke.mock.calls.map(([input]) => input)
      .filter(input => formatName(input) !== "supervisor_fused_entry");
    expect(inputs).toHaveLength(initialDelegation ? 3 : 4);
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
