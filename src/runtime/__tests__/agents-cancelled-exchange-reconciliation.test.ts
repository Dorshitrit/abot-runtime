import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentApplicationService, AgentWorkResult } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentApplicationFixture, applicationPlan, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const running: AgentWorkResult = {...completedAgentWork,status:"running",output:null,usage:null};
const cancelled: AgentWorkResult = {...completedAgentWork,status:"cancelled",output:null,error:"request_cancelled"};
async function delegatedWork() {
  const f = await agentApplicationFixture({result:running});
  const definition = (await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({kind:"register_agent",agentId:"abot",definition:{...definition,name:"ABot"}});
  let app!: AgentApplicationService;
  const coordination = createAgentCoordinationPort({store:f.store,application:() => app});
  const deps = {...f.dependencies,...coordination};
  app = trackAgentApplication(createAgentApplication(deps));
  f.invoke.mockImplementation(async input => {
    const capsule = JSON.parse((input.messages as ChatMessage[])[1]!.content);
    const agentId = capsule.mission.agentId ?? (await f.store.read()).missions.find(m => m.id === capsule.mission.id)!.agentId;
    const plan = agentId === "abot" ? applicationPlan("delegate_agent",{recipientAgentId:"agent-a"}) : applicationPlan("start_session");
    return {text:input.format ? JSON.stringify({decision:plan}) : "Read the supplied notes.",meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
  });
  await app.send("abot",{messageId:"task",text:"Delegate reading the notes",intent:"task",limits:agentMissionLimits()});
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce(), {timeout:5000});
  f.cancel.mockResolvedValue(running);
  await app.cancel("abot"); await app.whenIdle();
  expect((await f.store.read()).mailbox[0]!.status).toBe("unknown");
  return {...f,app,deps};
}

test("late measured cancellation charges only the exact original parent once and preserves a later child conversation", {timeout:20_000}, async () => {
  const f = await delegatedWork();
  const before = await f.store.read();
  const child = before.missions.find(mission => mission.agentId === "agent-a")!;
  const parent = before.missions.find(mission => mission.agentId === "abot")!;
  await f.app.send("agent-a",{messageId:"new-chat",text:"Hello",intent:"message"}); await f.app.whenIdle("agent-a");
  const newer = (await f.app.detail("agent-a")).mission!;
  f.inspect.mockResolvedValue(cancelled);
  await f.app.refresh("agent-a");
  const after = await f.store.read();
  const measuredChild = after.missions.find(mission => mission.id === child.id)!;
  expect(after.mailbox[0]).toMatchObject({status:"answered",outcome:"cancelled",output:before.mailbox[0]!.output,usage:{totalTokens:measuredChild.usage.totalTokens}});
  expect(after.missions.find(mission => mission.id === parent.id)!.usage.totalTokens).toBe(parent.usage.totalTokens + measuredChild.usage.totalTokens);
  expect((await f.app.detail("agent-a")).mission).toEqual(newer);
  await f.app.refresh("abot"); await f.app.refresh("agent-a");
  expect((await f.store.read()).mailbox).toEqual(after.mailbox);
  expect(f.run).toHaveBeenCalledOnce();
  expect(readAgentState(await f.store.read())).toEqual(await f.store.read());
});

test.each([{label:"measured",usage:cancelled.usage},{label:"unmeasured",usage:null}])("restart reconciles cancelled exchanges with $label child usage", async ({usage}) => {
    const f = await delegatedWork();
    f.inspect.mockResolvedValue({...cancelled,usage});
    const restored = trackAgentApplication(createAgentApplication(f.deps));
    await restored.recover();
    const state = await f.store.read();
    expect(state.mailbox[0]!.status).toBe(usage ? "answered" : "unknown");
    if (usage) expect(state.mailbox[0]!.outcome).toBe("cancelled");
    else {
      expect(state.mailbox[0]!.usage).toBeNull();
      expect([null,"cancelled"]).toContain(state.mailbox[0]!.outcome);
      f.inspect.mockResolvedValue(cancelled);
      await restored.refresh("agent-a");
      expect((await f.store.read()).mailbox[0]).toMatchObject({status:"answered",outcome:"cancelled",usage:expect.objectContaining({totalTokens:expect.any(Number)})});
    }
    expect(state.missions.every(mission => mission.status === "cancelled")).toBe(true);
    expect(f.run).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
}, 20_000);

test("the reconciliation command cannot resolve an active parent's unknown exchange", {timeout:20_000}, async () => {
  const f = await delegatedWork();
  const state = await f.store.read();
  const exchange = state.mailbox[0]!;
  const foreign = {...state,missions:state.missions.map(mission => mission.id === exchange.missionId ? {...mission,status:"active" as const} : mission)};
  const {reconcileCancelledExchange} = await import("../agents/cancelled-exchange-reducer.js");
  const result = reconcileCancelledExchange(foreign,{kind:"reconcile_cancelled_exchange",agentId:"abot",exchangeId:exchange.id},new Date().toISOString());
  expect(result.unchanged).toBe(true); expect(result.state).toBe(foreign);
});
