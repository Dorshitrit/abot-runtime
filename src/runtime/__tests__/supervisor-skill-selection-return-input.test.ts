import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestExecutionScope, type RequestExecutionScope } from "../request/execution-scope.js";
import type { SupervisorResumeContext } from "../steps/supervisor-decision/contracts.js";
import { prepareSupervisorDecision } from "../steps/supervisor-decision/preparation.js";
import { buildSupervisorSkillSelectionInput } from "../steps/supervisor-decision/skill-selection-input.js";
import { SUPERVISOR_SKILL_SELECTION_RETURN_CONTEXT_KIND } from "../steps/supervisor-decision/skill-selection-continuation.js";
import {
  CORE_SKILL_DOCUMENT, createCoreSkillContextFixture,
} from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const candidate = {
  skillId: "remaining-guidance", name: "Remaining guidance",
  description: "Applies to the remaining verification.", content: "UNREAD_PRIVATE_SKILL_BODY",
};

async function fixture() {
  const f = await createCoreSkillContextFixture();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify({ decision: { action: "continue" } }), meta: {},
  }));
  const store = {
    list: vi.fn(() => [CORE_SKILL_DOCUMENT, candidate]),
    read: vi.fn(() => undefined),
  };
  const request = createRequestExecutionScope({
    seed: {
      ...f.request,
      runnerConfig: {
        ...f.request.runnerConfig,
        steps: { ...f.request.runnerConfig.steps, "supervisor.decision": { timeoutMs: 20_000 } },
      },
      historyMessages: [{
        id: "previous-request", role: "user", content: "UNRELATED_HISTORY",
        createdAt: "2026-10-01T00:00:00.000Z",
      }],
      modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    },
    executionPolicy: f.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  return { ...f, request, invoke, store };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function withCapacity(request: RequestExecutionScope, capacity: number, countInputTokens?: ModelGatewayClient["countInputTokens"]) {
  return createRequestExecutionScope({
    seed: {
      ...request,
      modelPolicy: {
        ...request.modelPolicy!,
        profiles: {
          ...request.modelPolicy!.profiles,
          "contract-model": { ...request.modelPolicy!.profiles!["contract-model"]!, contextWindowTokens: capacity },
        },
      },
      modelGatewayClient: {
        invoke: request.modelGatewayClient.invoke,
        invokeRaw: request.modelGatewayClient.invokeRaw,
        ...(countInputTokens ? { countInputTokens } : {}),
      },
    },
    executionPolicy: request.executionPolicy, knowledgeSkillStore: request.knowledgeSkillStore,
    createWorkerCapabilities: () => request.workerCapabilities.provider,
  });
}

function prepare(f: Fixture, request: RequestExecutionScope, resume?: SupervisorResumeContext) {
  return prepareSupervisorDecision(request, {
    diagnostic: { requestId: request.requestId, modelStep: "supervisor.decision", decisionPhase: "skill_selection" },
    includeAcknowledgement: false, includeTitle: false, allowSkillReads: true,
    skillReadHead: f.ledger.current(), ...(resume ? { resume } : {}),
    skillSelectionWindow: request.supervisorSkillSelectionWindows.bind({
      rootCallId: f.ledger.current().state.rootCallId!,
      ...(resume ? { returnedResultRef: resume.returnedResultRef } : {}),
    }),
  });
}

function returnMessages(messages: readonly ChatMessage[]) {
  return messages.filter(({ content }) => {
    try { return JSON.parse(content).kind === SUPERVISOR_SKILL_SELECTION_RETURN_CONTEXT_KIND; }
    catch { return false; }
  });
}

test("returned context is one passive system capsule with one current user, no history and no Skill bodies", async () => {
  const f = await fixture();
  await f.read();
  const initial = buildSupervisorSkillSelectionInput(f.request, { skillReadHead: f.ledger.current() });
  await f.open("worker");
  const resume = await f.finish();
  const input = buildSupervisorSkillSelectionInput(f.request, {
    skillReadHead: f.ledger.current(), resume,
  });
  const messages = input.context.messages;
  expect(returnMessages(messages)).toHaveLength(1);
  expect(returnMessages(messages)[0]!.role).toBe("system");
  expect(messages.filter(({ role }) => role === "user")).toEqual([
    { role: "user", content: f.request.prompt },
  ]);
  expect(messages.every(({ role }) => role === "system" || role === "user")).toBe(true);
  const capsule = JSON.parse(returnMessages(messages)[0]!.content);
  expect(capsule).toMatchObject({
    requestId: f.request.requestId, childCallId: resume.returnedChildCallId,
    resultRef: resume.returnedResultRef, roleId: "worker", summary: "The target was checked.",
  });
  const serialized = JSON.stringify(messages);
  for (const hidden of [CORE_SKILL_DOCUMENT.content, candidate.content, "UNRELATED_HISTORY"])
    expect(serialized).not.toContain(hidden);
  expect(input.eligibleSkillIds).toEqual([candidate.skillId]);
  expect(input.format).toEqual(initial.format);
  expect(f.store.read).not.toHaveBeenCalled();
  // Existing child results alone do not alter the initial-selection envelope.
  expect(buildSupervisorSkillSelectionInput(f.request, {
    skillReadHead: f.ledger.current(),
  })).toEqual(initial);
});

test("a mismatched return is rejected before Store listing or provider invocation", async () => {
  const f = await fixture();
  await f.open("worker");
  const resume = await f.finish();
  const invalid = { ...resume, returnedResultRef: "forged-result-ref" };
  await expect(prepare(f, f.request, invalid)).rejects.toThrow("supervisor_skill_selection_return_result_mismatch");
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.request.supervisorSkillSelectionWindows.bind({
    rootCallId: resume.callerCallId, returnedResultRef: invalid.returnedResultRef,
  }).isOpen()).toBe(true);
});

test("return capsule consumes reference budget and is admitted only when the entire estimated envelope fits", async () => {
  const f = await fixture();
  const initial = buildSupervisorSkillSelectionInput(f.request);
  await f.open("worker");
  const resume = await f.finish();
  const input = buildSupervisorSkillSelectionInput(f.request, {
    skillReadHead: f.ledger.current(), resume,
  });
  const { budget } = input.context;
  expect(budget.parts.referenceInputTokens).toBeGreaterThan(initial.context.budget.parts.referenceInputTokens);
  expect(budget.parts.selectedHistoryInputTokens).toBe(0);
  expect(budget.formatReserveTokens).toBe(initial.context.budget.formatReserveTokens);
  const initialCapacity = initial.context.budget.estimatedInputTokens +
    budget.outputReserveTokens + budget.safetyReserveTokens;
  const exactCapacity = budget.estimatedInputTokens + budget.outputReserveTokens + budget.safetyReserveTokens;
  expect(exactCapacity).toBeGreaterThan(initialCapacity);
  await expect(prepare(f, withCapacity(f.request, initialCapacity)))
    .resolves.toMatchObject({ selection: { action: "continue" } });
  f.invoke.mockClear();
  for (const capacity of [initialCapacity, exactCapacity - 1]) {
    await expect(prepare(f, withCapacity(f.request, capacity), resume))
      .rejects.toThrow("request_context_final_envelope_exceeds_window");
  }
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  await expect(prepare(f, withCapacity(f.request, exactCapacity), resume))
    .resolves.toMatchObject({ selection: { action: "continue" } });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls[0]![0].messages).toEqual(input.context.messages);
  expect(f.invoke.mock.calls[0]![0].format).toEqual(initial.format);
});

test.each([false, true])("provider admission measures the full return capsule before dispatch (reject=%s)", async (reject) => {
  const f = await fixture();
  await f.open("worker");
  const resume = await f.finish();
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    expect(returnMessages(input.messages as readonly ChatMessage[])).toHaveLength(1);
    expect(input.messages).toEqual(expected.context.messages);
    expect(input.format).toEqual(expected.format);
    return {
      inputTokens: reject ? 15_000 : 1_000, profileId: "contract-model",
      provider: "openai", model: "contract-test", contextWindowTokens: 16_000,
      source: "provider_input_token_count",
    };
  });
  const request = withCapacity(f.request, 16_000, countInputTokens);
  const expected = buildSupervisorSkillSelectionInput(request, { skillReadHead: f.ledger.current(), resume });
  if (reject) {
    await expect(prepare(f, request, resume)).rejects.toThrow("request_context_final_envelope_exceeds_window");
    expect(f.invoke).not.toHaveBeenCalled();
  } else {
    await expect(prepare(f, request, resume)).resolves.toMatchObject({ selection: { action: "continue" } });
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls[0]![0].messages).toEqual(expected.context.messages);
  }
  expect(countInputTokens).toHaveBeenCalledOnce();
  expect(f.store.read).not.toHaveBeenCalled();
});
