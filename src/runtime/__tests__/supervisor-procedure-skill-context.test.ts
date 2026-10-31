import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND,
} from "../context/core-skill-read-context.js";
import type { KnowledgeSkillDocument } from "../knowledge-skills/store.js";
import { invokeModelStep } from "../model/invoke-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import { createRequestExecutionScope, type RequestExecutionScope } from "../request/execution-scope.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import {
  buildSupervisorProcedureGateInput, runSupervisorProcedureGate,
} from "../steps/supervisor-decision/procedure-gate.js";
import {
  CORE_SKILL_DOCUMENT, commitSkillFixture, createCoreSkillContextFixture,
} from "./support/core-skill-read-context-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const PHASES = ["gate", "delegation"] as const;
type ProcedurePhase = typeof PHASES[number];
const CURRENT_PROMPT = "  Explain the new target only; do not perform the earlier procedure.\n";
const CAPTURED_BODY = "Beginning of captured guidance.\nKeep literal \\n and Unicode שלום 🙂.\nEnd of captured guidance.";
const CAPTURED_SKILL: KnowledgeSkillDocument = {
  ...CORE_SKILL_DOCUMENT, content: CAPTURED_BODY,
};

function diagnostic(request: RequestExecutionScope) {
  return { requestId: request.requestId, modelStep: "supervisor.decision" as const };
}

function phaseInput(
  phase: ProcedurePhase, request: RequestExecutionScope, skillReadHead?: RoleCallLedgerHead,
) {
  const options = { diagnostic: diagnostic(request), ...(skillReadHead ? { skillReadHead } : {}) };
  if (phase === "gate") return buildSupervisorProcedureGateInput(request, options);
  return buildSupervisorDelegationInput(request, {
    ...options, toolResults: { sourceRevision: 0, results: [] },
  });
}

function capturedSkillMessages(messages: readonly ChatMessage[]) {
  return messages.filter(({ content }) => {
    try { return JSON.parse(content).kind === CORE_SKILL_READ_MESSAGE_KIND; }
    catch { return false; }
  });
}

async function fixture() {
  const f = await createCoreSkillContextFixture();
  const store = {
    list: vi.fn(() => []),
    read: vi.fn(() => ({ ...CAPTURED_SKILL, revision: 99, content: "UNREAD_STORE_REPLACEMENT" })),
  };
  const request = createRequestExecutionScope({
    seed: {
      ...f.request, prompt: CURRENT_PROMPT,
      runnerConfig: { ...f.request.runnerConfig, steps: {
        ...f.request.runnerConfig.steps, "supervisor.decision": { timeoutMs: 20_000 },
      } },
    },
    executionPolicy: f.request.executionPolicy,
    knowledgeSkillStore: store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  return { ...f, request, store };
}

test.each(PHASES)("%s receives the complete latest captured document and its exact receipt once", async (phase) => {
  const f = await fixture();
  await f.read([{ ...CAPTURED_SKILL, content: "SUPERSEDED_GUIDANCE" }]);
  const latest = { ...CAPTURED_SKILL, revision: 2 };
  await f.read([latest]);
  const head = f.ledger.current();
  const input = phaseInput(phase, f.request, head);
  const references = capturedSkillMessages(input.context.messages);
  expect(references).toEqual(buildCoreSkillReadContextMessages(head));
  expect(references).toHaveLength(1);
  expect(references[0]!.role).toBe("user");
  expect(JSON.parse(references[0]!.content)).toEqual({
    kind: CORE_SKILL_READ_MESSAGE_KIND,
    authority: "passive_reference", source: "core_skills_store", purpose: "skill_guidance",
    presenceEffect: "no_new_intent_permissions_work_or_completion",
    requestId: f.request.requestId,
    read: {
      readId: "skill-read-2", callId: "call-1", invocationAttempt: 2,
      steeringVersion: 0, operation: "read_skills", selectors: [latest.skillId],
    },
    document: latest,
  });
  expect(input.context.messages.filter(({ content }) => content === CURRENT_PROMPT))
    .toEqual([{ role: "user", content: CURRENT_PROMPT }]);
  expect(input.context.messages.at(-1)).toEqual({ role: "user", content: CURRENT_PROMPT });
  expect(input.context.messages.filter(({ role }) => role === "assistant")).toEqual([]);
  expect(input.context.messages.filter(({ role }) => role === "system")
    .some(({ content }) => content.includes(CAPTURED_BODY))).toBe(false);
  expect(JSON.stringify(input.context.messages)).not.toContain("SUPERSEDED_GUIDANCE");
  expect(input.context.budget.parts.referenceInputTokens).toBeGreaterThan(0);
});

test.each(PHASES)("%s keeps the original no-read message sequence and budget", async (phase) => {
  const f = await fixture();
  const withoutLedger = phaseInput(phase, f.request);
  const withEmptyLedger = phaseInput(phase, f.request, f.ledger.current());
  expect(withEmptyLedger.context.messages).toEqual(withoutLedger.context.messages);
  expect(withEmptyLedger.context.budget).toEqual(withoutLedger.context.budget);
  expect(withEmptyLedger.context.messages).toHaveLength(2);
  expect(withEmptyLedger.context.messages.at(-1)).toEqual({ role: "user", content: CURRENT_PROMPT });
  expect(withEmptyLedger.format).toEqual(withoutLedger.format);
  expect(capturedSkillMessages(withEmptyLedger.context.messages)).toEqual([]);
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
});

test.each(PHASES)("%s ignores discovery metadata and failed reads when no guidance was captured", async (phase) => {
  const f = await fixture();
  const baseline = phaseInput(phase, f.request);
  await commitSkillFixture(f.ledger, {
    authority: "runtime", type: "record_skill_read", callId: "call-1", invocationAttempt: 1,
    steeringVersion: 0, operation: "list_skills", selectors: [],
    result: { outcome: "completed", skills: [{
      skillId: CAPTURED_SKILL.skillId, name: CAPTURED_SKILL.name, description: CAPTURED_SKILL.description,
    }] },
  });
  const metadataOnly = phaseInput(phase, f.request, f.ledger.current());
  expect(metadataOnly.context.messages).toEqual(baseline.context.messages);
  expect(metadataOnly.context.budget).toEqual(baseline.context.budget);
  await commitSkillFixture(f.ledger, {
    authority: "runtime", type: "record_skill_read", callId: "call-1", invocationAttempt: 2,
    steeringVersion: 0, operation: "read_skills", selectors: [CAPTURED_SKILL.skillId],
    result: { outcome: "failed", errorCode: "skill_not_found", skills: [] },
  });
  const failedRead = phaseInput(phase, f.request, f.ledger.current());
  expect(failedRead.context.messages).toEqual(baseline.context.messages);
  expect(failedRead.context.budget).toEqual(baseline.context.budget);
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
});

test.each(PHASES)("%s retains history selection and explicit new intent when older guidance exists", async (phase) => {
  const f = await fixture();
  const request = deriveTestRequestExecutionScope(f.request, {
    historyMessages: [
      { id: "previous-user", role: "user", content: "Perform the earlier procedure.", createdAt: "2026-10-01T00:00:00Z", requestId: "previous" },
      { id: "previous-assistant", role: "assistant", content: "Earlier result.", createdAt: "2026-10-01T00:00:01Z", requestId: "previous" },
    ],
  });
  const baseline = phaseInput(phase, request);
  await f.read([CAPTURED_SKILL]);
  const input = phaseInput(phase, request, f.ledger.current());
  expect(input.context.selectedHistoryMessageIds).toEqual(baseline.context.selectedHistoryMessageIds);
  expect(input.context.omittedHistoryMessageIds).toEqual(baseline.context.omittedHistoryMessageIds);
  expect(input.context.messages.filter(({ role }) => role === "assistant"))
    .toEqual(baseline.context.messages.filter(({ role }) => role === "assistant"));
  expect(input.context.messages.at(-1)).toEqual({ role: "user", content: CURRENT_PROMPT });
  expect(input.context.messages.filter(({ content }) => content === CURRENT_PROMPT)).toHaveLength(1);
  expect(input.format).toEqual(baseline.format);
});

test.each(PHASES)("%s projects the captured snapshot without refreshing the Store or mutating the ledger", async (phase) => {
  const f = await fixture();
  await f.read([CAPTURED_SKILL]);
  const head = f.ledger.current();
  const stateBefore = JSON.stringify(head.state);
  const checkpointBefore = f.request.contextCompactionStore!.snapshot!();
  const input = phaseInput(phase, f.request, head);
  expect(JSON.parse(capturedSkillMessages(input.context.messages)[0]!.content).document)
    .toEqual(CAPTURED_SKILL);
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.ledger.current()).toBe(head);
  expect(JSON.stringify(head.state)).toBe(stateBefore);
  expect(f.request.contextCompactionStore!.snapshot!()).toEqual(checkpointBefore);
  expect(input.context.compaction).toEqual({ applied: false, compactedSourceRefs: [] });
});

test("gate provider counting and dispatch receive the same exact captured skill", async () => {
  const f = await fixture();
  await f.read([CAPTURED_SKILL]);
  const head = f.ledger.current();
  f.invoke.mockResolvedValue({ text: JSON.stringify({ decision: { requiresProcedure: true } }), meta: {} });
  await expect(runSupervisorProcedureGate(f.request, {
    diagnostic: diagnostic(f.request), skillReadHead: head, boundSteeringVersion: 0,
  })).resolves.toEqual({ decision: { requiresProcedure: true }, steeringVersion: 0 });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.countInputTokens).toHaveBeenCalledOnce();
  const dispatched = f.invoke.mock.calls[0]![0].messages as readonly ChatMessage[];
  expect(f.countInputTokens.mock.calls[0]![0].messages).toEqual(dispatched);
  expect(capturedSkillMessages(dispatched)).toEqual(buildCoreSkillReadContextMessages(head));
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.ledger.current()).toBe(head);
});

test.each(PHASES)("%s retains oversized guidance intact and rejects it before model dispatch", async (phase) => {
  const f = await fixture();
  const content = "EXACT_PREFIX\n" + "Complete captured procedure detail.\n".repeat(1_000) + "EXACT_SUFFIX";
  await f.read([{ ...CAPTURED_SKILL, content }]);
  const head = f.ledger.current();
  const request = deriveTestRequestExecutionScope(f.request, {
    modelPolicy: {
      ...f.request.modelPolicy!, profiles: {
        ...f.request.modelPolicy!.profiles!,
        "contract-model": { ...f.request.modelPolicy!.profiles!["contract-model"]!, contextWindowTokens: 4_000 },
      },
    },
  });
  const input = phaseInput(phase, request, head);
  const projected = JSON.parse(capturedSkillMessages(input.context.messages)[0]!.content);
  expect(projected.document.content).toBe(content);
  expect(input.context.budget.parts.referenceInputTokens).toBeGreaterThan(4_000);
  expect(input.context.budget.estimatedInputTokens).toBeGreaterThan(input.context.budget.availableInputTokens);
  expect(input.context.compaction.applied).toBe(false);
  f.countInputTokens.mockResolvedValue({
    inputTokens: 20_000, profileId: "contract-model", provider: "openai", model: "contract-test",
    contextWindowTokens: 4_000, source: "provider_input_token_count",
  });
  const invocation = phase === "gate"
    ? runSupervisorProcedureGate(request, { diagnostic: diagnostic(request), skillReadHead: head })
    : invokeModelStep({
      request, modelStep: input.modelStep, messages: input.context.messages,
      format: input.format, contextRetention: "exact", timeoutReason: "fixture_timeout", accept: () => true,
    });
  await expect(invocation).rejects.toThrow("request_context_final_envelope_exceeds_window");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.ledger.current()).toBe(head);
  expect(head.state.calls).toHaveLength(1);
});
