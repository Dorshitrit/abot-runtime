import { afterEach, expect, test, vi } from "vitest";
import { createAgentApplication } from "../agents/application-service.js";
import { agentApplicationFixture, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import type { AgentWorkResult } from "../agents/application-contracts.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const running: AgentWorkResult = {...completedAgentWork,status:"running",output:null,usage:null,receiptId:"running"};
const stopped: AgentWorkResult = {...completedAgentWork,status:"cancelled",output:null,error:"request_cancelled",receiptId:"terminal"};

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) test(`${policy}: an in-flight request reaching its token allowance is stopped through the ordinary port`, {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({policy,run:async () => new Promise(() => {})});
  f.inspect.mockResolvedValue(running);
  f.cancel.mockResolvedValue({...stopped,usage:null});
  const inspectUsage = vi.fn(async () => ({modelCalls:5,totalTokens:20_001}));
  const app = trackAgentApplication(createAgentApplication({...f.dependencies,work:{...f.dependencies.work,inspectUsage}}));
  await app.send("agent-a",{messageId:"task",text:"Research the supplied topic",intent:"task"});
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce(), {timeout:5000});
  await Promise.all([app.refresh("agent-a"), app.refresh("agent-a")]);
  await app.whenIdle();
  const detail = await app.detail("agent-a");
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(detail.mission!.status).toBe("exhausted");
  expect(detail.attempts[0]!.status).toBe("settled");
  expect(detail.attempts[0]!.result!.usage).toBeNull();
  expect(detail.messages.filter(message => message.role === "assistant")).toEqual([]);
  expect(detail.mission!.usage.totalTokens).toBe(policy === "execution-agent-v1" ? 20 : 30);
  expect((await f.store.read()).changes.some(change => change.reason === "agents_token_limit_reached")).toBe(true);
  expect(readAgentState(await f.store.read())).toEqual(await f.store.read());
});

test("a delayed budget cancellation remains stopped and is reconciled without repeat cancellation or double charging", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  const inspectUsage = vi.fn(async () => ({modelCalls:22,totalTokens:100}));
  const deps = {...f.dependencies,work:{...f.dependencies.work,inspectUsage}};
  const app = trackAgentApplication(createAgentApplication(deps));
  await app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await app.whenIdle();
  f.cancel.mockResolvedValue(running);
  await app.refresh("agent-a");
  expect((await app.detail("agent-a")).mission).toMatchObject({status:"awaiting_user_decision",waitingReason:"agents_model_call_limit_reached"});
  await app.refresh("agent-a"); expect(f.cancel).toHaveBeenCalledOnce();
  const measured = {...stopped,usage:{modelCalls:22,totalTokens:100}};
  f.inspect.mockResolvedValue(measured);
  await app.refresh("agent-a");
  const detail = await app.detail("agent-a");
  expect(detail.mission).toMatchObject({status:"exhausted",usage:{modelCalls:24,totalTokens:120}});
  await app.refresh("agent-a");
  expect((await app.detail("agent-a")).mission!.usage).toEqual(detail.mission!.usage);
  expect(f.run).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
});

test("restart honors the persisted budget stop and only cancels the same existing request", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  const deps = {...f.dependencies,work:{...f.dependencies.work,inspectUsage:async () => ({modelCalls:22,totalTokens:100})}};
  const app = trackAgentApplication(createAgentApplication(deps));
  await app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await app.whenIdle();
  f.cancel.mockResolvedValue(running); await app.refresh("agent-a");
  const request = (await app.detail("agent-a")).attempts[0]!.request;
  f.cancel.mockResolvedValue(stopped);
  const restored = trackAgentApplication(createAgentApplication(deps));
  await restored.recover(); await restored.refresh("agent-a");
  expect(f.cancel.mock.calls.map(call => call[0])).toEqual([request,request]);
  expect((await restored.detail("agent-a")).mission!.status).toBe("exhausted");
  expect(f.run).toHaveBeenCalledOnce();
});

test("unknown measurements cannot be invented into budget exhaustion", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  const app = trackAgentApplication(createAgentApplication({...f.dependencies,work:{...f.dependencies.work,inspectUsage:async () => null}}));
  await app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await app.whenIdle();
  await app.refresh("agent-a");
  expect((await app.detail("agent-a")).mission!.status).toBe("active");
  expect(f.cancel).not.toHaveBeenCalled();
});


test("a budget stop cannot resume or grant a new allowance while its cancellation remains unsettled", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  const app = trackAgentApplication(createAgentApplication({...f.dependencies,work:{...f.dependencies.work,
    inspectUsage:async () => ({modelCalls:22,totalTokens:100})}}));
  await app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await app.whenIdle();
  f.cancel.mockResolvedValue(running); await app.refresh("agent-a");
  const before = await app.detail("agent-a"), calls = f.invoke.mock.calls.length;
  await expect(app.resolve("agent-a",{action:"continue",text:"Continue",limits:agentMissionLimits()})).rejects.toThrow("agents_work_unresolved");
  await expect(f.store.commitApplication({kind:"resume_agent_turn",agentId:"agent-a",missionId:before.mission!.id,text:"Continue"})).rejects.toThrow("agents_work_unresolved");
  await expect(app.send("agent-a",{messageId:"chat",text:"How is it going?",intent:"message"})).rejects.toThrow("agents_work_unresolved"); await app.whenIdle();
  expect(f.invoke).toHaveBeenCalledTimes(calls); expect(f.run).toHaveBeenCalledOnce();
  expect((await f.store.read()).missions).toHaveLength(1);
  expect((await app.detail("agent-a")).messages.filter(message => message.role === "assistant")).toEqual([]);
});

test("a delayed budget-cancel result cannot exhaust a replacement conversation", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  const app = trackAgentApplication(createAgentApplication({...f.dependencies,work:{...f.dependencies.work,
    inspectUsage:async () => ({modelCalls:22,totalTokens:100})}}));
  await app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await app.whenIdle();
  const old = (await app.detail("agent-a")).mission!;
  let release!: (value:AgentWorkResult) => void;
  f.cancel.mockImplementationOnce(() => new Promise(resolve => {release=resolve;}));
  const refresh = app.refresh("agent-a");
  try {
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce(),{timeout:5000});
    await f.store.commitApplication({kind:"cancel_mission",agentId:"agent-a",missionId:old.id,reason:"User ended this task."});
    await app.send("agent-a",{messageId:"new-chat",text:"Hello",intent:"message"}); await app.whenIdle();
    const replacement = (await app.detail("agent-a")).mission!;
    release(stopped); await refresh;
    expect((await app.detail("agent-a")).mission).toEqual(replacement);
    expect((await f.store.read()).missions.find(mission => mission.id === old.id)!.status).toBe("cancelled");
    expect((await app.detail("agent-a")).attempts[0]!.status).toBe("settled");
  } finally { release?.(stopped); await refresh; }
});

for (const limit of [{maxModelCalls:1},{maxTotalTokens:1}]) test(`management exhaustion ${Object.keys(limit)[0]} is system state, never invented Agent speech`, {timeout:20_000}, async () => {
  const f = await agentApplicationFixture();
  await f.app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task",limits:{...agentMissionLimits(),...limit}});
  await f.app.whenIdle();
  const detail = await f.app.detail("agent-a");
  expect(detail.mission!.status).toBe("exhausted");
  expect(detail.messages.filter(message => message.role === "assistant")).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
});
