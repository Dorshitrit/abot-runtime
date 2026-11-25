import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { projectAgentContext } from "../agents/context-projection.js";
import { boundedAgentWorkAssignment, projectAgentWorkBudget } from "../agents/work-budget-context.js";
import { AGENT_WORKSPACE_TEXT_LIMIT } from "../agents/workspace-validation.js";
import { agentApplicationFixture, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
function context(messages: readonly ChatMessage[]) {
  return messages.flatMap(message => {
    try { const value = JSON.parse(message.content); return value.kind === "agent_context_v1" ? [value] : []; }
    catch { return []; }
  })[0];
}

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test(`${policy}: decisions see canonical remaining rounds; work retains its exact resource snapshot before dispatch`, async () => {
    const f = await agentApplicationFixture({policy});
    let dispatchedBudget: ReturnType<typeof projectAgentWorkBudget> | undefined;
    f.createSession.mockImplementation(async () => {
      const state = await f.store.read(), attempt = state.attempts[0]!;
      expect(attempt.status).toBe("claimed");
      const line = attempt.request.assignment.split("\n").find(value => value.startsWith('{"kind":"agent_work_budget_v1"'))!;
      dispatchedBudget = JSON.parse(line);
      expect(dispatchedBudget!.remaining.workRounds).toBe(state.missions[0]!.limits.maxAttempts);
      expect(dispatchedBudget!.remaining.tokens).toBe(state.missions[0]!.limits.maxTotalTokens - state.missions[0]!.usage.totalTokens);
      expect(dispatchedBudget!.remaining.modelCalls).toBe(state.missions[0]!.limits.maxModelCalls - state.missions[0]!.usage.modelCalls);
    });
    const request = "Compare only the two supplied notes.";
    await f.app.send("agent-a", {messageId:"task", text:request, intent:"task"});
    await f.app.whenIdle();
    const messages = f.invoke.mock.calls[0]![0].messages as ChatMessage[];
    expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual([request]);
    expect(context(messages).workBudget).toMatchObject({kind:"agent_work_budget_v1", addsUserIntent:false, grantsPermissions:false,
      executionPolicy:policy, remaining:{workRounds:4,modelCalls:24,tokens:20_000}, previousRound:null});
    expect(dispatchedBudget!.returnPlanning.estimatedModelCalls).toBe(policy === "supervisor-worker-v1" ? 6 : 3);
    expect((await f.store.read()).attempts[0]!.request.assignment).not.toContain("Find evidence for the assigned objective.");
    expect(f.run).toHaveBeenCalledOnce();
  });
}

test("conversation replies and unrelated work do not acquire a budget context or execution authority", async () => {
  const f = await agentApplicationFixture();
  await f.app.send("agent-a", {messageId:"chat", text:"How would you approach this?", intent:"message"});
  await f.app.whenIdle();
  const state = await f.store.read(), mission = state.missions[0]!, agent = state.agents[0]!;
  const base = {state,agentId:agent.id,missionId:mission.id,stage:"authoring" as const,instructions:"Reply",conversationMessageId:"chat"};
  const before = projectAgentContext(base);
  expect(context(before).workBudget).toBeUndefined();
  const other = {...structuredClone(state), missions:[...state.missions, {...mission,id:"unrelated",usage:{...mission.usage,totalTokens:19_999}}]};
  expect(projectAgentContext({...base,state:other})).toEqual(before);
  expect(f.run).not.toHaveBeenCalled();
});

test("work budget snapshots preserve unknown costs, use only the owned mission, and never mutate stored state", async () => {
  const f = await agentApplicationFixture();
  await f.app.send("agent-a", {messageId:"task",text:"Check the supplied notes",intent:"task"});
  await f.app.whenIdle();
  const state = await f.store.read(), mission = state.missions[0]!, agent = state.agents[0]!;
  const before = structuredClone(state);
  const initial = projectAgentWorkBudget(state,mission,agent);
  const altered = {...structuredClone(state), attempts:[{...state.attempts[0]!,result:{...state.attempts[0]!.result!,usage:null}},
    {...state.attempts[0]!,id:"foreign",agentId:"other",missionId:"elsewhere"}]};
  expect(projectAgentWorkBudget(altered,mission,agent).previousRound?.usage).toBeNull();
  expect(projectAgentWorkBudget(altered,mission,agent).previousRound?.attemptId).toBe(state.attempts[0]!.id);
  const later = {...mission,usage:{...mission.usage,attempts:3,totalTokens:19_000,modelCalls:21}};
  expect(projectAgentWorkBudget(state,later,agent).remaining).toEqual({workRounds:1,modelCalls:3,tokens:1000});
  expect(initial.remaining).not.toEqual({workRounds:1,modelCalls:3,tokens:1000});
  expect(state).toEqual(before);
});

test("an overlong bounded assignment fails before it can silently lose user instructions", async () => {
  const f = await agentApplicationFixture();
  await f.app.send("agent-a", {messageId:"chat",text:"Hello",intent:"message"});
  await f.app.whenIdle();
  const state = await f.store.read();
  expect(() => boundedAgentWorkAssignment("x".repeat(AGENT_WORKSPACE_TEXT_LIMIT),state,state.missions[0]!,state.agents[0]!))
    .toThrow("agents_work_assignment_too_long");
  expect(f.run).not.toHaveBeenCalled();
});
