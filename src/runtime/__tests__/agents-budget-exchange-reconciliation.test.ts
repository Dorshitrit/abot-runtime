import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentApplicationService, AgentWorkResult } from "../agents/application-contracts.js";
import type { AgentState } from "../agents/agent-records.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentApplicationObserver } from "../agents/application-observer.js";
import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import { reconcileCancelledExchange } from "../agents/cancelled-exchange-reducer.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentApplicationFixture, applicationPlan, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const running: AgentWorkResult = {...completedAgentWork,status:"running",output:null,usage:null};
const measured: AgentWorkResult = {...completedAgentWork,status:"cancelled",output:null,error:"request_cancelled",usage:{modelCalls:22,totalTokens:20_001}};
async function exhaustedDelegation(policy: "execution-agent-v1" | "supervisor-worker-v1" = "execution-agent-v1", measuredAtStop = false) {
  const f = await agentApplicationFixture({policy,result:running});
  const definition = (await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({kind:"register_agent",agentId:"abot",definition:{...definition,name:"ABot"}});
  let app!: AgentApplicationService;
  const coordination = createAgentCoordinationPort({store:f.store,application:() => app});
  const deps = {...f.dependencies,...coordination,work:{...f.dependencies.work,inspectUsage:async () => measured.usage}};
  app = trackAgentApplication(createAgentApplication(deps));
  f.cancel.mockResolvedValue({...measured,usage:measuredAtStop ? measured.usage : null});
  f.invoke.mockImplementation(async input => {
    const capsule = JSON.parse((input.messages as ChatMessage[])[1]!.content);
    const agentId = (await f.store.read()).missions.find(m => m.id === capsule.mission.id)!.agentId;
    const plan = agentId === "abot" ? applicationPlan("delegate_agent",{recipientAgentId:"agent-a"}) : applicationPlan("start_session");
    return {text:input.format ? JSON.stringify({decision:plan}) : "Read the supplied notes.",meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
  });
  await app.send("abot",{messageId:"task",text:"Delegate reading the notes",intent:"task",limits:agentMissionLimits()});
  await app.whenIdle();
  expect(f.run).toHaveBeenCalledOnce();
  expect((await app.detail("agent-a")).mission!.status).toBe("exhausted");
  return {...f,app,deps};
}

for (const policy of ["execution-agent-v1","supervisor-worker-v1"] as const) test(`${policy}: observer reconciles late delegated budget cost once after reopening`, {timeout:20_000}, async () => {
  const f = await exhaustedDelegation(policy);
  const before = await f.store.read(), parent = before.missions.find(m => m.agentId === "abot")!;
  const exchange = before.mailbox[0]!;
  expect(exchange).toMatchObject({status:"unknown",outcome:"exhausted",usage:null});
  expect(parent.status).toBe("awaiting_user_decision");
  await f.app.shutdown();
  const store = new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir,"agents","state.json"));
  const restored = trackAgentApplication(createAgentApplication({...f.deps,store}));
  await restored.recover();
  const observer = createAgentApplicationObserver({application:restored});
  await observer.start();
  try {
    expect((await store.read()).mailbox[0]).toEqual(exchange);
    // The exact receipt becomes measured outside the observer, as a live dispatch can do.
    const attempt = before.attempts[0]!;
    await store.commitApplication({kind:"observe_agent_work",agentId:attempt.agentId,attemptId:attempt.id,result:measured});
    const calls = f.invoke.mock.calls.length;
    await observer.tick();
    const after = await store.read(), child = after.missions.find(m => m.agentId === "agent-a")!;
    expect(after.mailbox[0]).toMatchObject({status:"answered",outcome:"exhausted",output:exchange.output,usage:{totalTokens:child.usage.totalTokens}});
    const expectedParent = {...parent,updatedAt:expect.any(String),usage:{...parent.usage,
      totalTokens:parent.usage.totalTokens+child.usage.totalTokens,modelCalls:parent.usage.modelCalls+child.usage.modelCalls,
      attempts:parent.usage.attempts+child.usage.attempts,clarificationRounds:parent.usage.clarificationRounds+child.usage.clarificationRounds}};
    expect(after.missions.find(m => m.id === parent.id)).toEqual(expectedParent);
    await observer.tick();
    expect((await store.read()).mailbox).toEqual(after.mailbox);
    expect((await store.read()).missions).toEqual(after.missions);
    expect(f.invoke).toHaveBeenCalledTimes(calls); expect(f.run).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
    expect(readAgentState(after)).toEqual(after);
  } finally { await observer.stop(); }
});

test("late budget cost stays with the original cancelled parent and child missions", {timeout:20_000}, async () => {
  const f = await exhaustedDelegation();
  const original = await f.store.read(), exchange = original.mailbox[0]!;
  await f.app.cancel("abot");
  await f.app.send("agent-a",{messageId:"new-chat",text:"Hello",intent:"message"}); await f.app.whenIdle();
  const newer = (await f.app.detail("agent-a")).mission!;
  const parent = (await f.app.detail("abot")).mission!;
  f.inspect.mockResolvedValue(measured);
  await f.app.refresh("agent-a");
  const after = await f.store.read(), child = after.missions.find(m => m.id === original.attempts[0]!.missionId)!;
  expect(after.mailbox[0]).toMatchObject({id:exchange.id,status:"answered",outcome:"exhausted"});
  expect(after.missions.find(m => m.id === parent.id)).toMatchObject({status:"cancelled",revision:parent.revision,usage:{totalTokens:parent.usage.totalTokens+child.usage.totalTokens}});
  expect((await f.app.detail("agent-a")).mission).toEqual(newer);
  expect(f.run).toHaveBeenCalledOnce();
});

test("budget reconciliation requires a stopped, measured, exactly bound child and a retained terminal exchange", {timeout:20_000}, async () => {
  const f = await exhaustedDelegation();
  const initial = await f.store.read(), attempt = initial.attempts[0]!, exchange = initial.mailbox[0]!;
  await f.store.commitApplication({kind:"observe_agent_work",agentId:attempt.agentId,attemptId:attempt.id,result:measured});
  const state = await f.store.read();
  const variants: AgentState[] = [
    {...state,changes:state.changes.filter(change => !change.reason.startsWith("agents_budget_stop:"))},
    {...state,changes:state.changes.map(change => ({...change,missionId:"unrelated"}))},
    {...state,mailbox:state.mailbox.map(entry => ({...entry,outcome:"completed" as const}))},
    {...state,mailbox:state.mailbox.map(entry => ({...entry,status:"pending" as const}))},
    {...state,messages:state.messages.map(message => message.source ? {...message,source:{...message.source,correlationId:"unrelated"}} : message)},
    {...state,attempts:initial.attempts},
    {...state,invocations:state.invocations.map(call => call.missionId === attempt.missionId ? {...call,status:"usage_unknown" as const,usage:null} : call)},
    {...state,missions:state.missions.map(mission => mission.id === exchange.missionId ? {...mission,status:"active" as const} : mission)},
  ];
  for (const variant of variants) {
    const result = reconcileCancelledExchange(variant,{kind:"reconcile_cancelled_exchange",agentId:"abot",exchangeId:exchange.id},new Date().toISOString());
    expect(result.unchanged).toBe(true); expect(result.state).toBe(variant);
  }
});

test("a measured receipt before peer settlement uses the ordinary single settlement", {timeout:20_000}, async () => {
  const f = await exhaustedDelegation("execution-agent-v1",true);
  const before = await f.store.read();
  expect(before.mailbox[0]).toMatchObject({status:"answered",outcome:"exhausted"});
  await f.app.refresh("abot"); await f.app.refresh("agent-a");
  expect((await f.store.read()).mailbox).toEqual(before.mailbox);
  expect(f.run).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
});
