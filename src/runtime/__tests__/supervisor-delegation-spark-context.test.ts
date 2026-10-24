import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appendSparkInitiativeRecord } from "../../sessions/assistant-initiative-append.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import { projectLatestCompleteConversationTurn, projectLatestSettledConversationTurn } from "../context/request-context.js";
import { projectRequestSource } from "../context/request-source.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { snapshotRequestHistory } from "../session/request-history.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createProcedureOrchestrationFixture } from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function initiativeHistory(id = "latest-proposal") {
  const session = appendSparkInitiativeRecord(null, "spark-companion", {
    title: "A previous suggestion",
    content: "  I suggested inspecting application Alpha.\nExact original suggestion.  ",
    initiative: {
      kind: "proactive_proposal_v1", proposalId: id,
      reason: "PRIVATE_REASON_SENTINEL",
      handoffBrief: "PRIVATE_HANDOFF_SENTINEL",
      sources: [{ kind: "memory", id: "PRIVATE_SOURCE_SENTINEL", version: "1" }],
    },
  }, new Date("2026-10-20T10:00:00Z"));
  return snapshotRequestHistory(session);
}

function project(historyMessages: readonly RequestHistoryMessage[], overrides: Partial<RequestExecutionSeed> = {}) {
  const fixture = createProcedureOrchestrationFixture(() => { throw new Error("unexpected_model_call"); });
  const request = deriveTestRequestExecutionScope(fixture.request, {
    historyMessages, prompt: "Inspect the application you just suggested.", ...overrides,
  });
  return {
    ...fixture, request,
    input: buildSupervisorDelegationInput(request, { toolResults: { sourceRevision: 0, results: [] } }),
  };
}

test.each(["spark", undefined] as const)("a canonical assistant initiative stays exact assistant history (session kind: %s)", (sessionKind) => {
  const history = initiativeHistory();
  const before = JSON.stringify(history);
  const { input, request, invoke } = project(history, { sessionKind });
  expect(input.context.messages.slice(1)).toEqual([
    { role: "assistant", content: history[0]!.content },
    { role: "user", content: request.prompt },
  ]);
  expect(input.context.selectedHistoryMessageIds).toEqual([history[0]!.id]);
  expect(input.context.omittedHistoryMessageIds).toEqual([]);
  expect(input.context.messages.filter(({ role }) => role === "user")).toHaveLength(1);
  for (const metadata of ["PRIVATE_REASON_SENTINEL", "PRIVATE_HANDOFF_SENTINEL", "PRIVATE_SOURCE_SENTINEL"])
    expect(JSON.stringify(input.context.messages)).not.toContain(metadata);
  expect(JSON.stringify(history)).toBe(before);
  expect(input.context.compaction).toEqual({ applied: false, compactedSourceRefs: [] });
  expect(invoke).not.toHaveBeenCalled();
});

test("a newer initiative replaces the older complete pair only for delegation", () => {
  const previous = createProcedureOrchestrationFixture(() => ({})).request.historyMessages;
  const initiative = initiativeHistory();
  const history = [...previous, ...initiative];
  const { input } = project(history);
  expect(input.context.selectedHistoryMessageIds).toEqual([initiative[0]!.id]);
  expect(input.context.omittedHistoryMessageIds).toEqual(previous.map(({ id }) => id));
  expect(input.context.messages.filter(({ role }) => role === "assistant"))
    .toEqual([{ role: "assistant", content: initiative[0]!.content }]);
  expect(projectLatestCompleteConversationTurn(history)?.map(({ id }) => id)).toEqual(["prior-user", "prior-assistant"]);
  const requestSource = projectRequestSource({
    requestId: "source-control", callId: "worker-call", modelStep: "worker.decision",
    prompt: "Keep the existing source contract.", historyMessages: history,
  });
  expect(requestSource.precedingTurn?.assistant.id).toBe("prior-assistant");
});

test("a newer complete pair supersedes the earlier assistant initiative", () => {
  const pair = createProcedureOrchestrationFixture(() => ({})).request.historyMessages.slice(-2);
  const initiative = initiativeHistory();
  const { input } = project([...initiative, ...pair]);
  expect(input.context.selectedHistoryMessageIds).toEqual(pair.map(({ id }) => id));
  expect(input.context.omittedHistoryMessageIds).toEqual([initiative[0]!.id]);
  expect(input.context.messages.slice(1, -1)).toEqual(pair.map(({ role, content }) => ({ role, content })));
});

test("only the latest canonical initiative is retained and unsettled or observational messages cannot replace it", () => {
  const earlier = initiativeHistory("earlier-proposal");
  const latest = initiativeHistory();
  const trailing: RequestHistoryMessage[] = [
    { id: "orphan", role: "assistant", content: "An unmatched ordinary answer.", requestId: "missing", createdAt: "2026-10-20T10:01:00Z" },
    { id: "observation", role: "assistant", content: "Observed state.", grounding: "tool_observation", createdAt: "2026-10-20T10:01:01Z", assistantInitiativeId: "not-conversation" },
    { id: "empty-initiative", role: "assistant", content: "  ", createdAt: "2026-10-20T10:01:02Z", assistantInitiativeId: "empty" },
    { id: "unfinished", role: "user", content: "An unfinished request.", requestId: "unfinished", createdAt: "2026-10-20T10:01:03Z" },
  ];
  const { input } = project([...earlier, ...latest, ...trailing]);
  expect(input.context.selectedHistoryMessageIds).toEqual([latest[0]!.id]);
  expect(input.context.omittedHistoryMessageIds).toEqual([...earlier, ...trailing].map(({ id }) => id));
  expect(projectLatestSettledConversationTurn(trailing)).toBeUndefined();
});

test.each(["Explain an unrelated concept.", "Inspect application Beta instead of the previous suggestion."])(
  "assistant history never replaces the current request: %s", (prompt) => {
    const history = initiativeHistory();
    const { input } = project(history, { prompt });
    expect(input.context.messages.at(-1)).toEqual({ role: "user", content: prompt });
    expect(input.context.messages.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: prompt }]);
    expect(input.context.messages.filter(({ content }) => content === history[0]!.content))
      .toEqual([{ role: "assistant", content: history[0]!.content }]);
    expect(input.context.selectedHistoryMessageIds).toEqual([history[0]!.id]);
  },
);

test("the pair-only request source contract does not manufacture a user from an initiative", () => {
  const history = initiativeHistory();
  expect(projectLatestCompleteConversationTurn(history)).toBeUndefined();
  const source = projectRequestSource({
    requestId: "source-control", callId: "worker-call", modelStep: "worker.decision",
    prompt: "Only the current request is active.", historyMessages: history,
  });
  expect(source).not.toHaveProperty("precedingTurn");
  expect(source.currentRequest).toBe("Only the current request is active.");
});
