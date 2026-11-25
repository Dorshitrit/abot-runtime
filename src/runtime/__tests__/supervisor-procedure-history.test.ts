import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestSessionMemory } from "../context/session-memory/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import {
  buildSupervisorProcedureGateInput, runSupervisorProcedureGate,
} from "../steps/supervisor-decision/procedure-gate.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  createProcedureOrchestrationFixture, procedureCapsules, procedureMessages,
  PROCEDURE_OLD_HISTORY,
} from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const priorRequest = "  Find today's news and save a summary in old-report.txt.\n";
const priorAnswer = "  May I search the web and save the summary in old-report.txt?\n";
const recommendation = "Answer only the current request using the supplied context.";
const finalAnswer = "Fixture response without external actions.";

function expectConversation(messages: readonly ChatMessage[], prompt: string, answer = priorAnswer) {
  expect(messages.filter(message => message.role !== "system").slice(-3)).toEqual([
    { role: "user", content: priorRequest },
    { role: "assistant", content: answer },
    { role: "user", content: prompt },
  ]);
  for (const content of [priorRequest, answer, prompt]) {
    expect(messages.filter(message => message.content === content)).toHaveLength(1);
  }
  expect(JSON.stringify(messages)).not.toContain(PROCEDURE_OLD_HISTORY);
}

function historyFixture(prompt = "אני מאשר", answer = priorAnswer) {
  const f = createProcedureOrchestrationFixture(() => ({ requiresProcedure: true }));
  const historyMessages = f.request.historyMessages.map(message => {
    if (message.id === "prior-user") return { ...message, content: priorRequest };
    if (message.id === "prior-assistant") return { ...message, content: answer };
    return message;
  });
  const request = deriveTestRequestExecutionScope(f.request, { prompt, historyMessages });
  const diagnostic = { requestId: request.requestId, modelStep: "supervisor.decision" as const };
  return { ...f, request, diagnostic };
}

// Scripted decisions verify context delivery and routing, not model interpretation.
test.each([
  { name: "approval", prompt: "אני מאשר", requiresProcedure: true,
    objective: "Find today's news and save the summary in old-report.txt." },
  { name: "refusal", prompt: "לא מאשר. אל תבצע את הפעולה.", requiresProcedure: false, objective: "" },
  { name: "unrelated request", prompt: "Explain what an RSS feed is.", requiresProcedure: false, objective: "" },
  { name: "explicit changed target", prompt: "Save the news summary in new-target/report.txt.", requiresProcedure: true,
    objective: "Find today's news and save the summary in new-target/report.txt." },
])("the latest settled turn reaches the gate for $name and the scripted decision controls routing", async scenario => {
  const f = historyFixture(scenario.prompt);
  const phases: string[] = [];
  f.invoke.mockImplementation(async input => {
    const phase = supervisorFormatName(input) ?? input.modelStep;
    if (!phase) throw new Error("fixture_model_phase_required");
    phases.push(phase);
    const result = (decision: unknown) => ({ text: JSON.stringify({ decision }), meta: {} });
    if (phase === "supervisor_fused_entry") {
      expectConversation(procedureMessages(input), scenario.prompt);
      return result({ ...(scenario.requiresProcedure
        ? { requiresProcedure: true }
        : { requiresProcedure: false, responseRecommendation: recommendation }), acknowledgement: "I will consider the current request." });
    }
    if (phase === "supervisor_fused_routing") {
      expect(scenario.requiresProcedure).toBe(true);
      expectConversation(procedureMessages(input), scenario.prompt);
      return result({ action: "invoke_role", roleId: "worker", objective: scenario.objective, workerCapabilityScope: { catalogGroupIds: ["read", "write"] }, workingDirectory: "." });
    }
    if (phase === "worker.decision") {
      expect(procedureCapsules(input).find(({ kind }) => kind === "runtime_worker_assignment"))
        .toMatchObject({ objective: scenario.objective, workingDirectory: "." });
      return result({ assessment: { requiresExecution: true, established: "", remaining: "The assigned outcome still requires execution.", evidenceRefs: [] }, selection: { action: "return_failure", reason: "The fixture deliberately performs no external action." } });
    }
    if (phase === "supervisor_decision") return result({ action: "respond" });
    expect(input.modelStep).toBe("supervisor.response");
    return { text: finalAnswer, meta: {} };
  });
  const historyBefore = JSON.stringify(f.request.historyMessages);
  await expect(runRequestRunner(f.request)).resolves.toEqual({ output: finalAnswer });
  expect(phases.filter(phase => phase === "supervisor_fused_entry")).toHaveLength(1);
  expect(phases.includes("supervisor_fused_routing")).toBe(scenario.requiresProcedure);
  expect(phases.includes("worker.decision")).toBe(scenario.requiresProcedure);
  expect(f.getAdapters).toHaveBeenCalledTimes(Number(scenario.requiresProcedure));
  for (const adapter of f.getAdapters.mock.results.flatMap(result => result.value)) {
    expect(adapter.execute).not.toHaveBeenCalled();
  }
  expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"tool.started"');
  expect(JSON.stringify(f.request.historyMessages)).toBe(historyBefore);
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(finalAnswer);
});

test("gate projection retains only the complete preceding turn and leaves session state untouched", async () => {
  const f = historyFixture();
  const project = vi.fn<RequestSessionMemory["project"]>(() => { throw new Error("unexpected_session_projection"); });
  const prepare = vi.fn<RequestSessionMemory["prepare"]>(async () => { throw new Error("unexpected_session_compaction"); });
  const snapshot = vi.fn<NonNullable<RequestSessionMemory["snapshot"]>>(() => { throw new Error("unexpected_session_snapshot"); });
  const request = deriveTestRequestExecutionScope(f.request, {
    sessionMemory: { project, prepare, snapshot },
    historyMessages: [...f.request.historyMessages,
      { id: "unfinished", role: "user", content: "UNFINISHED_TURN", requestId: "unfinished", createdAt: "2026-10-02T00:00:00Z" },
    ],
  });
  const historyBefore = JSON.stringify(request.historyMessages);
  const checkpointBefore = request.contextCompactionStore!.snapshot!();
  const input = buildSupervisorProcedureGateInput(request, { diagnostic: f.diagnostic });
  expectConversation(input.context.messages, request.prompt);
  expect(input.context.selectedHistoryMessageIds).toEqual(["prior-user", "prior-assistant"]);
  expect(JSON.stringify(input.context.messages)).not.toContain("UNFINISHED_TURN");
  expect(input.context.budget.parts.selectedHistoryInputTokens).toBeGreaterThan(0);
  expect(input.context.compaction).toEqual({ applied: false, compactedSourceRefs: [] });
  await runSupervisorProcedureGate(request, { diagnostic: f.diagnostic });
  expect(f.invoke.mock.calls[0]![0].messages).toEqual(input.context.messages);
  expect(project).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(JSON.stringify(request.historyMessages)).toBe(historyBefore);
  expect(request.contextCompactionStore!.snapshot!()).toEqual(checkpointBefore);
  expect(f.getAdapters).not.toHaveBeenCalled();
});

test("a large preceding turn stays byte-exact and oversized exact retention fails before dispatch", async () => {
  const answer = "START\n" + "  שלום 🙂 literal\\n\n".repeat(2000) + "END";
  const f = historyFixture("אני מאשר", answer);
  const request = deriveTestRequestExecutionScope(f.request, {
    modelPolicy: {
      ...f.request.modelPolicy!,
      profiles: { test: { ...f.request.modelPolicy!.profiles!.test!, contextWindowTokens: 4000 } },
    },
  });
  const historyBefore = JSON.stringify(request.historyMessages);
  const checkpointBefore = request.contextCompactionStore!.snapshot!();
  const input = buildSupervisorProcedureGateInput(request, { diagnostic: f.diagnostic });
  expectConversation(input.context.messages, request.prompt, answer);
  expect(input.context.budget.estimatedInputTokens).toBeGreaterThan(input.context.budget.availableInputTokens);
  expect(input.context.compaction.applied).toBe(false);
  await expect(runSupervisorProcedureGate(request, { diagnostic: f.diagnostic }))
    .rejects.toThrow("request_context_final_envelope_exceeds_window");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
  expect(f.getAdapters).not.toHaveBeenCalled();
  expect(JSON.stringify(request.historyMessages)).toBe(historyBefore);
  expect(request.contextCompactionStore!.snapshot!()).toEqual(checkpointBefore);
});

test.each([150, 100_000])("provider counting receives the exact gate history and enforces a count of %i", async inputTokens => {
  const f = historyFixture();
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    const invocation = resolveModelInvocation(input);
    return {
      inputTokens, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens },
  });
  const expected = buildSupervisorProcedureGateInput(request, { diagnostic: f.diagnostic });
  const run = runSupervisorProcedureGate(request, { diagnostic: f.diagnostic });
  if (inputTokens === 150) {
    await expect(run).resolves.toMatchObject({ decision: { requiresProcedure: true } });
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls[0]![0].messages).toEqual(expected.context.messages);
  } else {
    await expect(run).rejects.toThrow("request_context_final_envelope_exceeds_window");
    expect(f.invoke).not.toHaveBeenCalled();
  }
  expect(countInputTokens).toHaveBeenCalledOnce();
  expect(countInputTokens.mock.calls[0]![0].messages).toEqual(expected.context.messages);
  expectConversation(countInputTokens.mock.calls[0]![0].messages as readonly ChatMessage[], request.prompt);
  expect(f.getAdapters).not.toHaveBeenCalled();
});
