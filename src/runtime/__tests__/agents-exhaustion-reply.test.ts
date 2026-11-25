import { afterEach, expect, test } from "vitest";
import { agentExhaustionReply, projectLegacyExhaustionReply } from "../agents/exhaustion-reply.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";
import { projectAgentDetail } from "../agents/application-view.js";
import {
  agentApplicationFixture, applicationPlan, returnedWorkDecision, completedAgentWork, disposeAgentApplicationFixtures,
} from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);

async function exhaust() {
  let attempt = 0;
  const f = await agentApplicationFixture({
    choose: state => state.attempts.length ? returnedWorkDecision("continue_session") : applicationPlan("start_session"),
    run: async () => ({...completedAgentWork, output: "Recorded observation " + (++attempt)}),
  });
  await f.app.send("agent-a", {messageId: "request", text: "Check the available observations", intent: "task"});
  await f.app.whenIdle();
  const state = await f.store.read();
  return {f, state, mission: state.missions[0]!, message: state.messages.at(-1)!};
}

test("a hard cutoff atomically publishes the cause and same-mission partials with no extra calls", {timeout:20_000}, async () => {
  const {f, state, mission, message} = await exhaust();
  expect(mission.status).toBe("exhausted");
  expect(mission.usage.consecutiveNoProgress).toBe(2);
  expect(message).toMatchObject({purpose: "reply", role: "assistant", createdAt: mission.updatedAt});
  expect(message.text).toBe("Recorded observation 2");
  expect(message.text).not.toContain("agents_no_progress_limit_reached");
  expect(state.changes.at(-1)).toMatchObject({at: message.createdAt, reason: "agents_no_progress_limit_reached"});
  expect(state.changes.filter((entry) => entry.reason === "Conversation message retained in the Agent context.")).toHaveLength(0);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.invoke).toHaveBeenCalledTimes(4);
  await f.app.recover();
  await f.app.refresh(mission.agentId);
  expect((await f.app.detail(mission.agentId)).messages.filter((entry) => entry.id === message.id)).toHaveLength(1);
  expect(f.invoke).toHaveBeenCalledTimes(4);
});

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  const beforeDecision = policy === "execution-agent-v1" ? 4 : 5;
  const beforeAuthor = beforeDecision + (policy === "execution-agent-v1" ? 1 : 2);
  test.each([
    { stage: "selection", maxModelCalls: beforeDecision, output: "Worker: I could not verify shipping.\nThe item is out of stock." },
    { stage: "authoring", maxModelCalls: beforeAuthor, output: "Worker: The available evidence is inconclusive." },
    { stage: "selection without worker output", maxModelCalls: beforeDecision, output: null },
  ])(`${policy}: exhausted before $stage publishes only available model-authored text`, async ({ maxModelCalls, output }) => {
    const f = await agentApplicationFixture({ policy, result: { ...completedAgentWork, status: "failed", output, error: "source_unavailable" } });
    await f.app.send("agent-a", { messageId: "work", text: "Verify the candidate.", intent: "task", limits: { ...agentMissionLimits(), maxModelCalls } });
    await f.app.whenIdle();
    const detail = await f.app.detail("agent-a");
    expect(detail.mission).toMatchObject({ status: "exhausted", usage: { modelCalls: maxModelCalls, attempts: 1 } });
    const replies = detail.messages.filter(message => message.role === "assistant" && message.purpose === "reply");
    expect(replies.map(message => message.text)).toEqual(output ? [output] : []);
    expect(f.run).toHaveBeenCalledOnce();
    await f.app.recover(); await f.app.refresh("agent-a"); await f.app.whenIdle();
    expect((await f.app.detail("agent-a")).messages).toEqual(detail.messages);
    expect(f.run).toHaveBeenCalledOnce();
  });
}

test("legacy presentation needs the terminal change and original append identity and leaves saved text untouched", {timeout:20_000}, async () => {
  const {state, mission, message} = await exhaust();
  const originalText = "The agreed allowance is exhausted (agents_no_progress_limit_reached). Recorded results remain available in this Agent's sessions.";
  const olderMessage = {...message, purpose: undefined, text: originalText, createdAt: mission.createdAt};
  const terminal = state.changes.at(-1)!;
  const prior = {...terminal, sequence: terminal.sequence - 1, at: olderMessage.createdAt, reason: "Conversation message retained in the Agent context."};
  const legacy = {...state, messages: [...state.messages.slice(0, -1), olderMessage], changes: [...state.changes.slice(0, -1), prior, terminal]};
  const view = projectAgentDetail(legacy, mission.agentId, false);
  expect(view.messages.at(-1)).toEqual({...olderMessage, text: agentExhaustionReply(legacy, mission, terminal.reason)});
  expect(legacy.messages.at(-1)?.text).toBe(originalText);
  expect(projectLegacyExhaustionReply({...legacy, changes: [terminal]}, olderMessage)).toBe(olderMessage);
  expect(projectLegacyExhaustionReply({...legacy, changes: [prior]}, olderMessage)).toBe(olderMessage);
  const userQuote = {...olderMessage, role: "user" as const};
  expect(projectLegacyExhaustionReply(legacy, userQuote)).toBe(userQuote);
});

test("partial results are bounded and scoped across Agents, missions, outcomes and usage", {timeout:20_000}, async () => {
  const {state, mission} = await exhaust();
  const example = state.attempts[0]!;
  const result = {...completedAgentWork, output: "private-marker"};
  const attempts = [
    {...example, result, missionId: "older-task"}, {...example, result, agentId: "different-agent"},
    {...example, result: {...result, status: "failed" as const}}, {...example, result: {...result, usage: null}},
    ...Array.from({length: 4}, (_, index) => ({...example, id: String(index), result: {...result, output: `partial-${index} ${"x".repeat(3000)}`}})),
  ];
  const reply = agentExhaustionReply({...state, attempts}, mission, "agents_token_limit_reached");
  expect(reply).toContain("too few tokens");
  expect(reply).not.toContain("private-marker");
  expect(reply).not.toContain("partial-0");
  expect(reply).toContain("partial-3");
  expect(reply.length).toBeLessThan(2048);
  expect(agentExhaustionReply({...state, attempts: []}, mission, "agents_attempt_limit_reached")).toContain("no recorded result");
});
