import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { createAgentApplication } from "../agents/application-service.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import { agentApplicationFixture, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import type { AgentWorkResult } from "../agents/application-contracts.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const running: AgentWorkResult = {...completedAgentWork,status:"running",output:null,usage:null,receiptId:"running"};
const terminal: AgentWorkResult = {...completedAgentWork,status:"cancelled",output:null,error:"request_cancelled",receiptId:"terminal"};
async function cancelledWithoutUsage() {
  const f = await agentApplicationFixture({result:running});
  await f.app.send("agent-a",{messageId:"old",text:"Read notes",intent:"task"}); await f.app.whenIdle();
  f.cancel.mockResolvedValue({...terminal,usage:null}); await f.app.cancel("agent-a");
  return f;
}

test("late usage enriches the same closed receipt once without progress or execution after restart", async () => {
  const f = await cancelledWithoutUsage();
  const before = await f.store.read(), old = before.missions[0]!;
  await f.app.send("agent-a",{messageId:"new",text:"Hello",intent:"message"}); await f.app.whenIdle();
  const newer = (await f.app.detail("agent-a")).mission!, calls = f.invoke.mock.calls.length;
  f.inspect.mockResolvedValue(terminal);
  const store = new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir,"agents","state.json"));
  const restored = trackAgentApplication(createAgentApplication({...f.dependencies,store}));
  await restored.recover(); await restored.refresh("agent-a");
  const state = await store.read(), measured = state.missions.find(mission => mission.id === old.id)!;
  expect(measured.status).toBe("cancelled");
  expect(measured.usage).toEqual({...old.usage,modelCalls:old.usage.modelCalls+terminal.usage!.modelCalls,totalTokens:old.usage.totalTokens+terminal.usage!.totalTokens});
  expect((await restored.detail("agent-a")).mission).toEqual(newer);
  await restored.refresh("agent-a");
  expect(await store.read()).toEqual(state); expect(f.run).toHaveBeenCalledOnce(); expect(f.invoke).toHaveBeenCalledTimes(calls);
  await store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId:state.attempts[0]!.id,result:terminal});
  expect(await store.read()).toEqual(state);
  await store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId:state.attempts[0]!.id,result:{...terminal,usage:null}});
  expect(await store.read()).toEqual(state);
}, 20_000);

test("a late measurement cannot rewrite receipt identity, outcome, output, or already measured cost", async () => {
  const f = await cancelledWithoutUsage();
  const before = await f.store.read(), attemptId = before.attempts[0]!.id;
  for (const result of [{...terminal,receiptId:"foreign"},{...terminal,status:"completed" as const},{...terminal,output:"Changed"},{...terminal,error:"Changed"}]) {
    await expect(f.store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId,result})).rejects.toThrow("agents_attempt_settlement_conflict");
    expect(await f.store.read()).toEqual(before);
  }
  await f.store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId,result:terminal});
  await expect(f.store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId,result:{...terminal,usage:{modelCalls:3,totalTokens:999}}})).rejects.toThrow("agents_attempt_settlement_conflict");
}, 20_000);

test("a persisted budget-stop card survives a late management usage receipt and reopening", async () => {
  const f = await agentApplicationFixture({result:running});
  const deps = {...f.dependencies,work:{...f.dependencies.work,inspectUsage:async () => ({modelCalls:24,totalTokens:100})}};
  const app = trackAgentApplication(createAgentApplication(deps));
  await app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await app.whenIdle();
  const before = await f.store.read(), mission = before.missions[0]!, prior = before.invocations[0]!;
  await f.store.commitApplication({kind:"reserve_invocation",agentId:"agent-a",missionId:mission.id,invocationId:`progress:${mission.id}`,
    agentRevision:prior.agentRevision,missionRevision:mission.revision,configuration:prior.configuration,stage:"progress_report",reservedTokens:10});
  f.cancel.mockResolvedValue(terminal); await app.refresh("agent-a");
  expect((await app.detail("agent-a")).recovery.budgetStopReason).toBe("agents_model_call_limit_reached");
  await f.store.commitApplication({kind:"settle_invocation",agentId:"agent-a",invocationId:`progress:${mission.id}`,usage:{totalTokens:7,cost:{kind:"unknown"}}});
  const store = new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir,"agents","state.json"));
  const restored = trackAgentApplication(createAgentApplication({...deps,store}));
  expect((await restored.detail("agent-a")).recovery).toMatchObject({budgetStopReason:"agents_model_call_limit_reached",budgetStopping:false});
  expect((await restored.detail("agent-a")).messages.filter(message => message.role === "assistant")).toEqual([]);
}, 20_000);
