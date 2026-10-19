import { resolve } from "node:path";
import type { SupervisorDelegateRoleId, SupervisorResumeContext } from "../steps/supervisor-decision/contracts.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONTEXT_COMPACTION_TRIGGER_RATIO } from "../context/request-context-budget.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import {
  estimateConfiguredStepInstructionReserveTokens,
  projectConfiguredStepMessages,
} from "../config/runner/step-instructions.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { buildSupervisorDecisionInstructions } from "../steps/supervisor-decision/prompt.js";
import {
  buildSupervisorWorkingDirectoryInput,
  createSupervisorWorkingDirectoryFormat,
} from "../steps/supervisor-decision/working-directory.js";
import { createMemoryRecallHarness } from "./support/memory-recall-runner.js";

const modelStep = "supervisor.decision" as const;
const installationConfig = loadRequestRunnerConfig({ configPath: resolve("examples/request-runner.config.example.json") });
const catalog = [{ groupId: "knowledge", memberCount: 1, effects: ["observation" as const] }];
const toolResults = { sourceRevision: 0, results: [] };

function createRequest() {
  const { request } = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }),
  });
  return {
    ...request,
    historyMessages: [{
      id: "previous-user", role: "user" as const, content: "Keep answers brief.",
      createdAt: "2026-10-01T00:00:00.000Z", requestId: "previous-request",
    }],
  };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createReturnedChildContext(outcome: "completed" | "failed"): SupervisorResumeContext {
  return {
    callerCallId: "call-1", invocationAttempt: 3,
    returnedChildCallId: "call-2", returnedResultRef: "result-1",
    completedChildren: [{
      callerCallId: "call-1", childCallId: "call-2", resultRef: "result-1", roleId: "worker",
      objective: "Perform the delegated external operation.",
      workingDirectory: "projects/supervisor-owned",
      workerCapabilityScope: { catalogGroupIds: ["documents", "write"] },
      dependencyResultRefs: [], outcome,
      summary: outcome === "completed" ? "The delegated operation completed." : "The delegated operation failed.",
    }],
  };
}

test.each(["initial", "completed", "failed"] as const)(
  "assembles identical bounded SUPER context with configured, installed and empty steps: %s", (phase) => {
    const request = createRequest();
    const options = {
      toolResults, allowMemoryRecall: true,
      includeAcknowledgement: phase === "initial", includeTitle: phase === "initial",
      allowedRoleIds: ["planner", "worker", "reviewer"] as const,
      availableWorkerCapabilityCatalog: catalog,
      ...(phase === "initial" ? {} : {
        resume: createReturnedChildContext(phase),
        diagnostic: { requestId: request.requestId, modelStep, callId: "call-1", invocationAttempt: 3 },
      }),
    };
    const configured = buildSupervisorDecisionInput(request, options);
    for (const steps of [request.runnerConfig.steps, installationConfig.steps, {}]) {
      const runnerConfig = { ...request.runnerConfig, steps };
      const input = buildSupervisorDecisionInput({ ...request, runnerConfig }, options);
      const projected = projectConfiguredStepMessages({ runnerConfig, modelStep, messages: input.context.messages });
      expect(projected.blockCount).toBe(0);
      expect(projected.messages).toEqual(configured.context.messages);
      // Include restored routing/read prerequisites and the resumed completion gate.
      expect(projected.messages[0]!.content.length).toBeLessThan(10_000);
      expect(input.context.selectedHistoryMessageIds).toEqual(configured.context.selectedHistoryMessageIds);
      expect(input.context.budget).toEqual(configured.context.budget);
      expect(input.context.budget.configuredInstructionReserveTokens).toBeUndefined();
      expect(input.context.messages.filter(({ role, content }) =>
        role === "user" && content === request.prompt)).toHaveLength(1);
      expect(input.format).toEqual(configured.format);
    }
  },
);

test.each(["completed", "failed"] as const)(
  "keeps built-in resumed context intact with optional configured guidance: %s", (outcome) => {
    const request = createRequest();
    const options = {
      toolResults, allowedRoleIds: ["worker", "reviewer"] as const,
      resume: createReturnedChildContext(outcome),
      diagnostic: { requestId: request.requestId, modelStep, callId: "call-1", invocationAttempt: 3 },
    };
    const plain = buildSupervisorDecisionInput(request, options);
    const block = { ref: "test-only.md", content: "Test-only additional guidance.", contentHash: "test-only-hash" };
    const runnerConfig = { ...request.runnerConfig, steps: {
      ...request.runnerConfig.steps, [modelStep]: { timeoutMs: 20_000, instructionBlocks: [block] },
    } };
    const input = buildSupervisorDecisionInput({ ...request, runnerConfig }, options);
    const projected = projectConfiguredStepMessages({ runnerConfig, modelStep, messages: input.context.messages });
    expect(input.context.messages).toEqual(plain.context.messages);
    expect(projected.blockCount).toBe(1);
    expect(projected.messages[0]!.content.startsWith(plain.context.messages[0]!.content)).toBe(true);
    expect(projected.messages[0]!.content.split(block.content)).toHaveLength(2);
    expect(projected.messages.slice(1)).toEqual(plain.context.messages.slice(1));
    expect(input.context.budget.configuredInstructionReserveTokens).toBe(
      estimateConfiguredStepInstructionReserveTokens({ runnerConfig, modelStep }),
    );
    expect(input.context.budget.availableInputTokens).toBeLessThan(plain.context.budget.availableInputTokens);
    expect(input.format).toEqual(plain.format);
  },
);

const roleSets: readonly (readonly SupervisorDelegateRoleId[])[] = [
  [], ["planner"], ["worker", "reviewer"], ["researcher"],
];
test.each(roleSets.map((allowedRoleIds) => ({ allowedRoleIds })))(
  "keeps offered role identities aligned with the existing schema: $allowedRoleIds", ({ allowedRoleIds }) => {
    const input = buildSupervisorDecisionInput(createRequest(), {
      toolResults, allowedRoleIds, availableWorkerCapabilityCatalog: catalog,
    });
    const identities = [...input.context.messages[0]!.content.matchAll(/"roleId":"([^"]+)"/g)]
      .map((match) => match[1]);
    expect(identities.sort()).toEqual([...allowedRoleIds].sort());
    expect(input.format).toEqual(createSupervisorDecisionFormat({
      allowedRoleIds, includeResponseRecommendation: true,
      availableWorkerCapabilityCatalog: allowedRoleIds.includes("worker") ? catalog : [],
    }));
  },
);

test("keeps memory availability local to instructions and recall availability in the schema", () => {
  const request = createRequest();
  const enabled = buildSupervisorDecisionInput(request, { toolResults });
  const disabled = buildSupervisorDecisionInput({
    ...request, longTermMemory: { ...request.longTermMemory!, enabled: false },
  }, { toolResults });
  expect(enabled.context.messages[0]!.content.length).toBeGreaterThan(disabled.context.messages[0]!.content.length);
  expect(enabled.context.messages.slice(1)).toEqual(disabled.context.messages.slice(1));
  expect(enabled.format).toEqual(disabled.format);
  for (const allowMemoryRecall of [false, true]) {
    const input = buildSupervisorDecisionInput(request, { toolResults, allowMemoryRecall });
    expect(JSON.stringify(input.format).includes('"recall_memory"')).toBe(allowMemoryRecall);
    expect(input.context.messages[0]!.content.includes("recall_memory")).toBe(allowMemoryRecall);
  }
});

test("keeps bounded child evidence guidance conditional without copying it into the initial prompt", () => {
  const initial = buildSupervisorDecisionInstructions();
  const resumed = buildSupervisorDecisionInstructions({ hasCompletedChildResult: true, hasRequestToolResults: true });
  expect(initial).not.toContain("workLineage.capabilityExecutionIds");
  expect(resumed.match(/workLineage\.capabilityExecutionIds/g)).toHaveLength(1);
  expect(resumed.length).toBeLessThan(10_000);
});

test("preserves the catalog-free Worker affordance fallback and suppresses it without Worker", () => {
  const affordances = [{ effect: "observation" as const, purpose: "Test-only external observation." }];
  const fallback = buildSupervisorDecisionInstructions({ allowedRoleIds: ["worker"], workerCapabilityAffordances: affordances });
  expect(fallback).toContain(JSON.stringify(affordances));
  for (const options of [
    { allowedRoleIds: ["planner"] as const },
    { allowedRoleIds: ["worker"] as const, availableWorkerCapabilityCatalog: catalog },
  ]) {
    expect(buildSupervisorDecisionInstructions({ ...options, workerCapabilityAffordances: affordances }))
      .not.toContain(JSON.stringify(affordances));
  }
});

test("keeps the frozen working-directory phase identical with configured and installed steps without routing appendices", () => {
  const request = createRequest();
  const routing = buildSupervisorDecisionInput(request, { toolResults });
  const frozenDecision = { action: "invoke_role" as const, roleId: "planner" as const, objective: "Create the requested project." };
  const directory = buildSupervisorWorkingDirectoryInput(routing.context, { frozenDecision });
  const projected = projectConfiguredStepMessages({
    runnerConfig: request.runnerConfig, modelStep: directory.modelStep, messages: directory.messages,
  });
  expect(directory.format).toEqual(createSupervisorWorkingDirectoryFormat());
  expect(directory.format.schema).toMatchObject({ required: ["workingDirectory"], additionalProperties: false });
  expect(directory.messages[0]!.content).not.toBe(routing.context.messages[0]!.content);
  expect(JSON.parse(directory.messages.at(-1)!.content)).toMatchObject({
    kind: "runtime_supervisor_frozen_invocation_v1", roleId: frozenDecision.roleId, objective: frozenDecision.objective,
  });
  expect(projected.blockCount).toBe(0);
  expect(projected.messages).toEqual(directory.messages);
  const installedRouting = buildSupervisorDecisionInput({
    ...request, runnerConfig: { ...request.runnerConfig, steps: installationConfig.steps },
  }, { toolResults });
  const installedDirectory = buildSupervisorWorkingDirectoryInput(installedRouting.context, { frozenDecision });
  expect(directory.messages).toEqual(installedDirectory.messages);
  expect(directory.format).toEqual(installedDirectory.format);
});

test("compacts settled child continuation without emitting inner lifecycle events", () => {
  const base = createRequest();
  const onEvent = vi.fn();
  const request = {
    ...base, onEvent,
    // Isolate pinned child continuation; history is selected after its compaction gate.
    historyMessages: [],
    runnerConfig: { ...base.runnerConfig, context: {
      outputReserveTokens: 0, safetyReserveTokens: 0, attachmentReserveTokens: 0,
    } },
  };
  const returned = createReturnedChildContext("completed");
  const child = returned.completedChildren[0]!;
  const lineageFingerprint = `sha256:${"a".repeat(64)}`;
  const resume: SupervisorResumeContext = {
    ...returned,
    completedChildren: [{
      ...child,
      receipt: {
        kind: "work_result_v1", producerCallId: child.childCallId,
        callerCallId: child.callerCallId, sourceRevision: 1, lineageFingerprint,
      },
      workLineage: { kind: "work_result_lineage_v1", lineageFingerprint, capabilityExecutionIds: [] },
    }],
  };
  const options: Parameters<typeof buildSupervisorDecisionInput>[1] = {
    toolResults, allowedRoleIds: [],
    diagnostic: { requestId: request.requestId, modelStep, callId: "call-1", invocationAttempt: 3 },
    resume,
  };
  const uncompressed = buildSupervisorDecisionInput(request, options);
  expect(uncompressed.context.compaction.applied).toBe(false);
  // Cross the admission threshold using the current input, not a fixed prompt length.
  const contextWindowTokens = Math.floor(
    (uncompressed.context.budget.estimatedInputTokens - 1) / CONTEXT_COMPACTION_TRIGGER_RATIO,
  );
  const input = buildSupervisorDecisionInput({
    ...request,
    modelPolicy: { ...request.modelPolicy, profiles: {
      ...request.modelPolicy!.profiles,
      test: { ...request.modelPolicy!.profiles!.test!, contextWindowTokens },
    } },
  }, options);
  expect(uncompressed.context.budget.estimatedInputTokens).toBeGreaterThan(input.context.budget.compactionTriggerInputTokens);
  expect(input.context.budget.estimatedInputTokens).toBeLessThan(input.context.budget.compactionTriggerInputTokens);
  expect(input.context.compaction).toEqual({
    applied: true, compactedSourceRefs: ["supervisor-children:call-1:3:result-1"],
  });
  const parsedMessages = input.context.messages.flatMap(({ content }) => {
    try { return [JSON.parse(content) as Record<string, unknown>]; }
    catch { return []; }
  });
  expect(parsedMessages.filter((message) => message.action === "invoke_role")).toHaveLength(0);
  expect(parsedMessages.find((message) => message.kind === "runtime_child_result")).toMatchObject({
    resultRef: "result-1", delegatedObjective: "Perform the delegated external operation.",
    workingDirectory: "projects/supervisor-owned",
    workerCapabilityScope: { catalogGroupIds: ["documents", "write"] },
    outcome: "completed", summary: "The delegated operation completed.",
    workReceipt: resume.completedChildren[0]!.receipt,
    workLineage: resume.completedChildren[0]!.workLineage,
  });
  expect(onEvent).not.toHaveBeenCalled();
});
