import { afterEach, expect, test, vi } from "vitest";
import { agentApplicationFixture, disposeAgentApplicationFixtures } from "../../runtime/__tests__/support/agents-application-fixture.js";
import { createAgentManagementModel } from "../../runtime/agents/management-model.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { AgentApplicationDetail } from "../../runtime/agents/application-contracts.js";
import type { AgentState } from "../../runtime/agents/agent-records.js";
import { createAgentChatUpdates } from "./agent-chat-updates.js";
import { createAgentProgressReporter } from "./agent-progress-reporter.js";
import { createAgentCoordinationPort } from "../../runtime/agents/coordination-port.js";
import { applicationPlan } from "../../runtime/__tests__/support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures);

async function workingMission(maxModelCalls?: number) {
  let admitWork!: () => void;
  const admitted = new Promise<void>(resolve => { admitWork = resolve; });
  const f = await agentApplicationFixture({run: () => { admitWork(); return new Promise(() => {}); }});
  const defaults = (await f.store.read()).agents[0]!.definition.defaultLimits!;
  await f.app.send("agent-a", {messageId:"long-task", text:"בדוק את המקורות", intent:"auto",
    ...(maxModelCalls === undefined ? {} : {limits:{...defaults,maxModelCalls}})});
  await admitted;
  const detail = await f.app.detail("agent-a");
  const now = Date.parse(detail.attempts[0]!.createdAt) + 300_001;
  const source = {agentId:detail.agent.id, missionId:detail.mission!.id, workId:detail.attempts[0]!.id,
    workKind:"work_session" as const, dueAt:new Date(now).toISOString(), lastUpdateText:"אני בודק את המקורות",
    workUsage:{modelCalls:2,totalTokens:100}};
  return {f, detail, now, source};
}

test.each([24, 4, 3])("quiet reporting respects a %i-call allowance across concurrent observers and reopening", async (maxModelCalls) => {
  const {f, detail, now, source} = await workingMission(maxModelCalls);
  const before = (await f.store.read()).missions[0]!.usage;
  expect(before.modelCalls).toBe(2);
  const admission = detail.responsibility.find(trace => trace.accepted && trace.plan.publicUpdate)!.plan.publicUpdate!;
  for (const [input] of f.invoke.mock.calls) expect(JSON.stringify(input.messages)).not.toContain(admission);
  const publication = "הבדיקה עדיין מתבצעת, ואעדכן כשיתקבלו ממצאים.";
  f.invoke.mockResolvedValue({text:publication,meta:{usage:{inputTokens:20,outputTokens:8,totalTokens:28}}});
  const attempt = detail.attempts[0]!;
  const {sessionId, requestId} = attempt.request;
  const started = attempt.createdAt;
  const generation = "active-generation";
  const session: SessionRecord = {
    id:sessionId, title:"Test work", createdAt:started, updatedAt:started, messages:[], messageCount:0, lastAgentMode:"reasoning",
    requests:[{requestId, sessionId, generation, status:"streaming", createdAt:started, updatedAt:started, lastSeqNo:1,
      events:[{requestId, seqNo:1, timestamp:started, type:"event", payload:{
        name:"context.window.snapshot", sessionId, requestId, generation, invocationId:"active-call", admissionOutcome:"accepted"
      }}]}],
  };
  const sessions = {getSessionById: async () => session};
  const projection = createAgentChatUpdates(sessions);
  expect(await projection.checkpoint(detail, await f.store.read(), now - 2)).toBeNull();
  const view = { checkpoint: (d: AgentApplicationDetail, s: AgentState) => projection.checkpoint(d, s, now) };
  const a = createAgentProgressReporter(f.dependencies,view), b = createAgentProgressReporter(f.dependencies,view);
  try {
    a.observe([detail],now); b.observe([detail],now);
    await Promise.all([a.whenIdle(), b.whenIdle()]);
    const records = (await f.store.read()).invocations.filter(call => call.stage === "progress_report");
    const state = await f.store.read();
    if (maxModelCalls === 3) {
      expect(records).toEqual([]);
      expect(state.missions[0]!.usage).toEqual(before);
      expect((await createAgentChatUpdates(sessions)(detail, state)).map(report => report.text)).toEqual([admission]);
    } else {
      expect(records).toMatchObject([{publicUpdate:publication,status:"settled"}]);
      expect((await createAgentChatUpdates(sessions)(detail, state)).map(report => report.text)).toEqual([admission, publication]);
      expect(state.missions[0]!.usage).toMatchObject({modelCalls:before.modelCalls + 1,totalTokens:before.totalTokens + 28});
      const call = f.invoke.mock.calls.find(([args]) => args.debugRequestId === `progress:${source.missionId}`)![0];
      expect(call.messages).toEqual([expect.objectContaining({role:"system"}), expect.objectContaining({role:"system"}), {role:"user",content:"בדוק את המקורות"}]);
      expect(JSON.stringify(call.messages)).not.toContain(detail.attempts[0]!.request.assignment);
    }
  } finally { await Promise.all([a.stop(), b.stop()]); }
  const reopened = createAgentProgressReporter(f.dependencies,view);
  reopened.observe([detail],now + 600_000); await reopened.whenIdle(); await reopened.stop();
  expect(f.invoke.mock.calls.filter(([args]) => args.debugRequestId === `progress:${source.missionId}`)).toHaveLength(maxModelCalls === 3 ? 0 : 1);
});

test.each(["calls", "tokens"])("an optional status respects %s already spent by the active worker", async (limit) => {
  const {f, detail, source} = await workingMission();
  const limits = detail.mission!.limits;
  const live = {...source, workUsage: {modelCalls: limit === "calls" ? limits.maxModelCalls - detail.mission!.usage.modelCalls : 1,
    totalTokens: limit === "tokens" ? limits.maxTotalTokens - detail.mission!.usage.totalTokens : 10}};
  const invoke = createAgentManagementModel(f.dependencies);
  const before = f.invoke.mock.calls.length;
  await expect(invoke({agentId:detail.agent.id, missionId:source.missionId, stage:"progress_report", instructions:"",
    signal:new AbortController().signal, progress:{source:live,current:async () => live}})).rejects.toThrow("agents_progress_allowance_unavailable");
  expect(f.invoke.mock.calls.length).toBe(before);
  expect((await f.store.read()).invocations.some(call => call.stage === "progress_report")).toBe(false);
});

test("a fresh public update overtaking a pending report suppresses stale text and keeps the measured charge", async () => {
  const {f, detail, now, source} = await workingMission();
  let live: typeof source | null = source;
  const reporter = createAgentProgressReporter(f.dependencies,{checkpoint:async () => live});
  f.invoke.mockImplementationOnce(async () => {
    live = null;
    return {text:"Stale status",meta:{usage:{totalTokens:17,inputTokens:10,outputTokens:7}}};
  });
  try {
    reporter.observe([detail],now);
    await reporter.whenIdle();
    const record=(await f.store.read()).invocations.find(call => call.stage === "progress_report");
    expect(record).toMatchObject({status:"settled",usage:{totalTokens:17}}); expect(record?.publicUpdate).toBeUndefined();
  } finally { await reporter.stop(); }
});


test("delegated quiet work reports once in the child budget and reaches both chats without private assignments", async () => {
  let admitWork!: () => void;
  const admitted = new Promise<void>(resolve => { admitWork = resolve; });
  const f = await agentApplicationFixture({
    choose: state => state.mailbox.length ? applicationPlan("start_session") : applicationPlan("delegate_agent", { recipientAgentId: "agent-a" }),
    run: () => { admitWork(); return new Promise(() => {}); },
  });
  const definition = (await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({ kind: "register_agent", agentId: "abot", definition: { ...definition, name: "ABot" } });
  Object.assign(f.dependencies, createAgentCoordinationPort({ store: f.store, application: () => f.app }));
  await f.app.send("abot", { messageId: "delegated-progress-request", text: "בדוק את המקורות", intent: "auto" });
  await admitted;
  const parent = await f.app.detail("abot"), child = await f.app.detail("agent-a");
  const before = await f.store.read();
  const attempt = child.attempts[0]!;
  const { sessionId, requestId } = attempt.request;
  const started = attempt.createdAt, generation = "delegated-generation";
  const now = Date.parse(started) + 300_001;
  const session: SessionRecord = {
    id: sessionId, title: "Private child session", createdAt: started, updatedAt: started, messages: [], messageCount: 0, lastAgentMode: "reasoning",
    requests: [{ requestId, sessionId, generation, status: "streaming", createdAt: started, updatedAt: started, lastSeqNo: 1,
      events: [{ requestId, seqNo: 1, timestamp: started, type: "event", payload: {
        name: "context.window.snapshot", sessionId, requestId, generation, invocationId: "active-child-call", admissionOutcome: "accepted",
      } }] }],
  };
  const project = createAgentChatUpdates({ getSessionById: async () => session });
  const view = { checkpoint: (detail: AgentApplicationDetail, state: AgentState) => project.checkpoint(detail, state, now) };
  expect(await view.checkpoint(parent, before)).toBeNull();
  expect(await view.checkpoint(child, before)).not.toBeNull();
  const publication = "אני עדיין בודק את המקורות ואעדכן כשיהיו ממצאים.";
  f.invoke.mockResolvedValue({ text: publication, meta: { usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } } });
  const reporters = [createAgentProgressReporter(f.dependencies, view), createAgentProgressReporter(f.dependencies, view)];
  try {
    for (const reporter of reporters) reporter.observe([parent, child], now);
    await Promise.all(reporters.map(reporter => reporter.whenIdle()));
  } finally { await Promise.all(reporters.map(reporter => reporter.stop())); }
  const after = await f.store.read();
  const reports = after.invocations.filter(call => call.stage === "progress_report");
  expect(reports).toMatchObject([{ agentId: "agent-a", missionId: child.mission!.id, publicUpdate: publication, status: "settled" }]);
  expect(after.missions.find(mission => mission.id === parent.mission!.id)!.usage).toEqual(parent.mission!.usage);
  expect(after.missions.find(mission => mission.id === child.mission!.id)!.usage).toMatchObject({
    modelCalls: child.mission!.usage.modelCalls + 1, totalTokens: child.mission!.usage.totalTokens + 28,
  });
  expect((await project(child, after)).at(-1)?.text).toBe(publication);
  expect((await project(parent, after)).at(-1)).toMatchObject({ text: publication, missionId: parent.mission!.id, sourceAgentId: "agent-a" });
  const calls = f.invoke.mock.calls.filter(([args]) => args.debugRequestId === `progress:${child.mission!.id}`);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0].messages).toEqual([expect.objectContaining({ role: "system" }), expect.objectContaining({ role: "system" }), { role: "user", content: "בדוק את המקורות" }]);
  expect(JSON.stringify(calls[0]![0].messages)).not.toContain(attempt.request.assignment);
  const reopened = createAgentProgressReporter(f.dependencies, view);
  reopened.observe([parent, child], now + 600_000); await reopened.whenIdle(); await reopened.stop();
  expect(f.invoke.mock.calls.filter(([args]) => args.debugRequestId === `progress:${child.mission!.id}`)).toHaveLength(1);
});
