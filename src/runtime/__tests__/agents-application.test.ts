import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import type { AgentApplicationService } from "../agents/application-contracts.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { afterEach, expect, test, vi } from "vitest";
import { agentApplicationFixture, returnedWorkDecision, applicationPlan, completedAgentWork, trackAgentApplication, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";
import { createAgentApplication } from "../agents/application-service.js";
import { projectAgentContext } from "../agents/context-projection.js";
import { readAgentState } from "../agents/state-validation.js";
import type { AgentWorkResult } from "../agents/application-contracts.js";
afterEach(disposeAgentApplicationFixtures,20_000);

for(const policy of ["execution-agent-v1","supervisor-worker-v1"] as const) test(`${policy}: owns context, persists intent before ordinary calls and evaluates the result`, {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({policy});
  f.createSession.mockImplementation(async()=>{
    const state=await f.store.read();
    expect(state.attempts[0]).toMatchObject({status:"claimed",claimId:expect.any(String)});
    expect(await f.app.associatedSessionIds()).toContain(state.attempts[0]!.request.sessionId);
  });
  await f.app.send("agent-a",{messageId:"user-1",text:"Find a monitor with verified pricing",intent:"task"});
  await f.app.whenIdle();
  const detail=await f.app.detail("agent-a"),state=await f.store.read();
  expect(detail.mission?.status).toBe("completed");expect(f.run).toHaveBeenCalledTimes(1);
  expect(state.attempts[0]?.request).toMatchObject({modelProfileId:"fixture-super",toolPermissionMode:"ask"});
  expect(state.invocations.map((entry)=>entry.stage)).toEqual(policy==="execution-agent-v1"?["assessment_and_selection","authoring","assessment_and_selection","authoring"]:["assessment","selection","authoring","assessment","selection","authoring"]);
  expect(detail.mission?.usage).toMatchObject({attempts:1,modelCalls:state.invocations.length+2,totalTokens:state.invocations.length*10+20});
  expect(state.responsibility.every((entry)=>entry.accepted)).toBe(true);
  const first=f.invoke.mock.calls[0]![0];expect(first.modelPreference).toEqual({profileId:"fixture-super",scope:"all"});expect(first.modelStep).toBeUndefined();
  expect((first.messages as ChatMessage[]).filter((entry)=>entry.role==="user"&&entry.content==="Find a monitor with verified pricing")).toHaveLength(1);
  await f.app.send("agent-a",{messageId:"user-1",text:"Find a monitor with verified pricing",intent:"task"});expect(f.run).toHaveBeenCalledTimes(1);
  expect(readAgentState(state)).toEqual(state);
});

test("continues only an owned session and ends after deterministic no-progress, even when prose changes", {timeout:20_000}, async()=>{
  let count=0;
  const f=await agentApplicationFixture({choose:(state)=>state.attempts.length?returnedWorkDecision("continue_session"):applicationPlan("start_session"),run:async()=>({...completedAgentWork,receiptId:`r-${++count}`,output:`Different prose ${count}; same source https://example.test/source`})});
  await f.app.send("agent-a",{messageId:"u",text:"Research thoroughly",intent:"task"});await f.app.whenIdle();
  const detail=await f.app.detail("agent-a");expect(detail.mission?.status).toBe("exhausted");expect(detail.attempts).toHaveLength(3);expect(f.createSession).toHaveBeenCalledTimes(1);
  expect(detail.mission?.usage.consecutiveNoProgress).toBe(2);
});

test("a measured failed result can be answered without asserting that criteria were met", async () => {
  const f = await agentApplicationFixture({ result: { ...completedAgentWork, status: "failed", output: "The source could not be verified." } });
  await f.app.send("agent-a", { messageId: "u", text: "Verify the result", intent: "task" });
  await f.app.whenIdle();
  const detail = await f.app.detail("agent-a");
  expect(detail.mission?.status).toBe("completed");
  expect(detail.responsibility.at(-1)).toMatchObject({ accepted: true, plan: {
    action: "answer_user", evidenceIds: [detail.attempts[0]!.id], metCriteriaIds: [],
  } });
  expect(f.run).toHaveBeenCalledOnce();
});

test("unknown usage belongs to the user and never resets the old allowance", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({result:{...completedAgentWork,usage:null}});
  await f.app.send("agent-a",{messageId:"u",text:"Do the work",intent:"task"});await f.app.whenIdle();
  const before=await f.app.detail("agent-a");expect(before.recovery.requiresNewBudget).toBe(true);
  await expect(f.app.resolve("agent-a",{action:"continue",text:"I acknowledge the unknown outcome"})).rejects.toMatchObject({code:"agents_unknown_resolution_requires_limits"});
  await f.app.resolve("agent-a",{action:"continue",text:"Check the previous result independently",limits:agentMissionLimits()});await f.app.whenIdle();
  const state=await f.store.read();expect(state.missions).toHaveLength(2);expect(state.missions[0]?.status).toBe("cancelled");expect(state.missions[0]?.usage).toEqual(before.mission?.usage);expect(state.attempts[0]?.result?.usage).toBeNull();
});

test("deletion after closing a mission distinguishes an unmeasured terminal session from an unknown external outcome", {timeout:20_000}, async()=>{
  for (const status of ["completed","unknown"] as const) {
    const f = await agentApplicationFixture({result:{...completedAgentWork,status,usage:null}});
    await f.app.send("agent-a",{messageId:"work",text:"Check the requested information",intent:"task"});
    await f.app.whenIdle();
    if (status === "unknown") f.cancel.mockRejectedValueOnce(new Error("Cancellation could not be confirmed"));
    await f.app.cancel("agent-a");
    const closed = await f.store.read();
    expect(closed.missions[0]?.status).toBe("cancelled");
    expect(closed.attempts[0]?.result?.usage).toBeNull();
    if (status === "unknown") {
      expect(closed.attempts[0]?.status).toBe("unknown");
      await expect(f.store.beginDeletion("agent-a", closed.revision)).rejects.toThrow("agents_deletion_unresolved");
      expect(await f.store.read()).toEqual(closed);
    } else {
      expect(closed.attempts[0]?.status).toBe("settled");
      await f.store.beginDeletion("agent-a", closed.revision);
      expect((await f.store.finishDeletion("agent-a")).attempts).toEqual([]);
    }
  }
});

test("retains malformed decision trace and never dispatches or repairs it automatically", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({choose:()=>"A confident answer that is not JSON"});
  await f.app.send("agent-a",{messageId:"u",text:"Do work",intent:"task"});await f.app.whenIdle();
  expect(f.run).not.toHaveBeenCalled();expect((await f.app.detail("agent-a")).responsibility[0]).toMatchObject({accepted:false,code:"malformed_proposal"});expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("idle conversation cannot acquire task authority", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture();await f.app.send("agent-a",{messageId:"chat",text:"How would you approach this?",intent:"message"});await f.app.whenIdle();
  const detail=await f.app.detail("agent-a");
  expect(f.run).not.toHaveBeenCalled();expect(f.createSession).not.toHaveBeenCalled();expect(detail.responsibility).toEqual([]);
  expect(detail.mission?.status).toBe("completed");expect(detail.messages.at(-1)).toMatchObject({id:"reply:chat",role:"assistant"});expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("conversation while work is running uses a separate model call and the same budget", {timeout:20_000}, async()=>{
  let release!:(value:AgentWorkResult)=>void;
  const f=await agentApplicationFixture({run:()=>new Promise((resolve)=>{release=resolve;})});
  await f.app.send("agent-a",{messageId:"task",text:"Find current facts",intent:"task"});await vi.waitFor(()=>expect(f.run).toHaveBeenCalledOnce(),{timeout:5000});
  const before=(await f.app.detail("agent-a")).mission!;
  await f.app.send("agent-a",{messageId:"chat",text:"Explain what you are checking",intent:"message"});
  await vi.waitFor(async()=>expect((await f.app.detail("agent-a")).messages.some((entry)=>entry.id==="reply:chat")).toBe(true),{timeout:5000});
  const during=await f.app.detail("agent-a");expect(during.mission?.objective).toBe(before.objective);expect(during.mission?.usage.modelCalls).toBe(before.usage.modelCalls+1);expect(f.run).toHaveBeenCalledOnce();
  const call=f.invoke.mock.calls.find(([input])=>(input.messages as ChatMessage[])[0]?.content.includes("Reply to the newest user's conversation"))![0];expect((call.messages as ChatMessage[]).filter((entry)=>entry.role==="user"&&entry.content==="Explain what you are checking")).toHaveLength(1);expect((call.messages as ChatMessage[]).at(-1)?.content).toBe("Explain what you are checking");
  release(completedAgentWork);await f.app.whenIdle();
});

test("restart never replays a claimed request with persisted running status", {timeout:20_000}, async()=>{
  let release!:(value:AgentWorkResult)=>void;
  const f=await agentApplicationFixture({run:()=>new Promise((resolve)=>{release=resolve;})});
  await f.app.send("agent-a",{messageId:"task",text:"One attempt only",intent:"task"});await vi.waitFor(()=>expect(f.run).toHaveBeenCalledOnce(),{timeout:5000});
  f.inspect.mockResolvedValue({...completedAgentWork,status:"running",usage:null});
  const restored=trackAgentApplication(createAgentApplication(f.dependencies)),count=f.invoke.mock.calls.length;await restored.recover();await restored.refresh("agent-a");
  expect(f.run).toHaveBeenCalledOnce();expect(f.invoke).toHaveBeenCalledTimes(count);expect((await restored.detail("agent-a")).recovery.requiresNewBudget).toBe(true);
  release(completedAgentWork);await f.app.whenIdle();
});

test("failed intent persistence prevents session creation and dispatch", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture(),original=f.store.commitApplication.bind(f.store);
  vi.spyOn(f.store,"commitApplication").mockImplementation(async(command)=>{if(command.kind==="prepare_agent_work")throw new Error("injected_before_attempt_publication");return original(command);});
  await f.app.send("agent-a",{messageId:"task",text:"Do work",intent:"task"});await f.app.whenIdle();expect(f.createSession).not.toHaveBeenCalled();expect(f.run).not.toHaveBeenCalled();
});

test("zero history projection really omits history and reload preserves exact records", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({choose:()=>applicationPlan("answer_user")});
  await f.app.send("agent-a",{messageId:"old",text:"Old conversation",intent:"message"});await f.app.whenIdle();
  await f.app.send("agent-a",{messageId:"new",text:"New conversation",intent:"message"});await f.app.whenIdle();
  const state=await f.store.read(),messages=projectAgentContext({state,agentId:"agent-a",missionId:state.missions.at(-1)!.id,instructions:"Test",historyLimit:0});
  expect(messages).toHaveLength(3);expect(JSON.stringify(messages)).not.toContain("Old conversation");expect(state.messages.some((entry)=>entry.text==="Old conversation")).toBe(true);
});

test("schedule source revision guard is checked inside the durable command", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture();await expect(f.app.send("agent-a",{messageId:"scheduled",text:"Bound assignment",intent:"task",expectedAgentRevision:2})).rejects.toMatchObject({code:"agents_agent_revision_conflict"});expect((await f.store.read()).missions).toHaveLength(0);expect(f.invoke).not.toHaveBeenCalled();
});

for(const policy of ["execution-agent-v1","supervisor-worker-v1"] as const) test(`${policy}: work stays in its original session and later tasks can open another or reuse the first`, {timeout:20_000}, async()=>{
  const f = await agentApplicationFixture({ policy, choose: state => {
    const mission = state.missions.at(-1)!;
    const attempts = state.attempts.filter(entry => entry.missionId === mission.id);
    if (!attempts.length) {
      if (state.missions.length === 3) return applicationPlan("continue_session", { sessionId: state.sessions[0]!.sessionId });
      return applicationPlan("start_session");
    }
    if (state.missions.length === 1 && attempts.length === 1) return returnedWorkDecision("continue_session");
    return returnedWorkDecision();
  } });
  let sequence = 0;
  f.run.mockImplementation(async () => ({ ...completedAgentWork, receiptId: `result-${++sequence}`, output: `Verified source https://example.test/source-${sequence}` }));
  for (const [id, text] of [["first", "Find and compare an item"], ["second", "Check a different item"], ["third", "Recheck the first item"]] as const) {
    await f.app.send("agent-a", { messageId: id, text, intent: "task" });
    await f.app.whenIdle();
    expect((await f.app.detail("agent-a")).mission?.status).toBe("completed");
  }
  const detail = await f.app.detail("agent-a");
  const [first, second] = detail.sessions.map(entry => entry.sessionId);
  expect(detail.sessions).toHaveLength(2);
  expect(detail.attempts.map(entry => entry.request.sessionId)).toEqual([first, first, second, first]);
  expect(f.createSession).toHaveBeenCalledTimes(2);
});

test("clarification remains in the same mission and budget and is projected once as user authority", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({choose:(state)=>state.messages.some((entry)=>entry.purpose==="clarification")?applicationPlan("answer_user"):applicationPlan("ask_user")});
  await f.app.send("agent-a",{messageId:"q",text:"Help me choose",intent:"task"});await f.app.whenIdle();const before=await f.app.detail("agent-a");
  expect(before.mission?.usage.clarificationRounds).toBe(1);
  await f.app.resolve("agent-a",{action:"continue",text:"The budget is 500"});await f.app.whenIdle();const after=await f.app.detail("agent-a");
  expect(after.mission?.id).toBe(before.mission?.id);expect(after.mission?.usage.modelCalls).toBeGreaterThan(before.mission!.usage.modelCalls);expect(after.mission?.limits).toEqual(before.mission?.limits);
  const last=f.invoke.mock.calls.at(-1)![0].messages as ChatMessage[];expect(last.filter((entry)=>entry.role==="user"&&entry.content==="The budget is 500")).toHaveLength(1);
});

test("owned conversation facts survive follow-up, while another Agent's private context is absent", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({choose:()=>applicationPlan("answer_user")});
  await f.app.send("agent-a",{messageId:"fact",text:"My preferred refresh rate is 144 Hz",intent:"message"});await f.app.whenIdle();
  const state=await f.store.read();await f.store.commitApplication({kind:"register_agent",agentId:"other",definition:{...state.agents[0]!.definition,basePrompt:"PRIVATE_OTHER_AGENT_MARKER"}});
  await f.app.send("agent-a",{messageId:"followup",text:"What refresh rate did I prefer?",intent:"message"});await f.app.whenIdle();
  const messages=f.invoke.mock.calls.at(-1)![0].messages as ChatMessage[];expect(JSON.stringify(messages)).toContain("144 Hz");expect(JSON.stringify(messages)).not.toContain("PRIVATE_OTHER_AGENT_MARKER");expect(messages.at(-1)?.content).toBe("What refresh rate did I prefer?");
});

test("known parked approval resumes from its recorded result without a second dispatch", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({result:{...completedAgentWork,status:"awaiting_approval",usage:null}});
  await f.app.send("agent-a",{messageId:"task",text:"Do the approved work",intent:"task"});await f.app.whenIdle();expect((await f.app.detail("agent-a")).status).toBe("awaiting_approval");
  const restored=trackAgentApplication(createAgentApplication(f.dependencies));await restored.recover();expect((await restored.detail("agent-a")).status).toBe("awaiting_approval");
  f.inspect.mockResolvedValue(completedAgentWork);await restored.refresh("agent-a");await restored.whenIdle();expect((await restored.detail("agent-a")).mission?.status).toBe("completed");expect(f.run).toHaveBeenCalledOnce();
});

test("explicit pause and steering preserve known accounting, cancel ordinary work and advance task revision", {timeout:20_000}, async()=>{
  let release!:(value:AgentWorkResult)=>void;
  const f=await agentApplicationFixture({run:()=>new Promise((resolve)=>{release=resolve;})});
  await f.app.send("agent-a",{messageId:"task",text:"Original task",intent:"task"});await vi.waitFor(()=>expect(f.run).toHaveBeenCalledOnce(),{timeout:5000});
  const cancelled={...completedAgentWork,status:"cancelled" as const};f.cancel.mockImplementation(async()=>{release(cancelled);return cancelled;});
  const before=await f.app.detail("agent-a");const paused=await f.app.pause("agent-a");expect(paused.status).toBe("awaiting_user_decision");expect(f.cancel).toHaveBeenCalledOnce();
  f.invoke.mockImplementation(async()=>({text:JSON.stringify({decision:applicationPlan("wait")}),meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}}));
  await f.app.resolve("agent-a",{action:"continue",text:"Narrow the comparison to 144 Hz"});await f.app.whenIdle();const after=await f.app.detail("agent-a");
  expect(after.mission?.id).toBe(before.mission?.id);expect(after.mission?.revision).toBeGreaterThan(before.mission!.revision);expect(after.mission?.limits).toEqual(before.mission?.limits);expect(after.mission?.usage.attempts).toBe(1);
});


test("ABot delegates to a real Agent and retains its reply in one bounded budget without leaking child conversation", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({choose:()=>applicationPlan("answer_user")});
  await f.app.send("agent-a",{messageId:"private",text:"PRIVATE_CHILD_CONVERSATION_MARKER",intent:"message"});await f.app.whenIdle();
  const definition=(await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({kind:"register_agent",agentId:"abot",definition:{...definition,name:"ABot",defaultLimits:{...agentMissionLimits(),maxModelCalls:40,maxTotalTokens:50000}}});
  let app!:AgentApplicationService;const coordination=createAgentCoordinationPort({store:f.store,application:()=>app});
  app=trackAgentApplication(createAgentApplication({...f.dependencies,...coordination}));
  f.invoke.mockImplementation(async(input)=>{
    const messages=input.messages as ChatMessage[],capsule=JSON.parse(messages[1]!.content),state=await f.store.read(),mission=state.missions.find((entry)=>entry.id===capsule.mission.id)!;
    let text="A bounded public assignment or verified result.";
    if(input.format) {
      const attempts=state.attempts.filter((entry)=>entry.missionId===mission.id),exchange=state.mailbox.find((entry)=>entry.missionId===mission.id);
      const plan=mission.agentId==="abot"?(exchange?applicationPlan("complete",{evidenceIds:[exchange.id],metCriteriaIds:["request"]}):applicationPlan("delegate_agent",{recipientAgentId:"agent-a"})):(attempts.length?returnedWorkDecision():applicationPlan("start_session"));
      text=JSON.stringify({decision:plan});
    }
    if(mission.agentId==="abot")expect(JSON.stringify(messages)).not.toContain("PRIVATE_CHILD_CONVERSATION_MARKER");
    return {text,meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
  });
  await app.send("abot",{messageId:"team-task",text:"Ask the research Agent to verify this",intent:"task"});await app.whenIdle("abot");
  const state=await f.store.read(),parent=state.missions.find((entry)=>entry.agentId==="abot")!,exchange=state.mailbox[0]!;
  expect(parent.status).toBe("completed");expect(exchange).toMatchObject({status:"answered",outcome:"completed",usage:{attempts:1,modelCalls:6,totalTokens:60}});expect(parent.usage).toMatchObject({attempts:1,modelCalls:10,totalTokens:100,clarificationRounds:1});
  expect(state.messages.find((entry)=>entry.source?.correlationId===exchange.id)).toMatchObject({role:"abot",source:{agentId:"abot",missionId:parent.id}});expect(f.run).toHaveBeenCalledOnce();
});

test("persisted evidence hash and aggregate work usage cannot be corrupted on reload", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture();await f.app.send("agent-a",{messageId:"u",text:"Collect evidence",intent:"task"});await f.app.whenIdle();const state=await f.store.read();
  expect(()=>readAgentState({...state,attempts:[{...state.attempts[0]!,outputHash:"tampered"}]})).toThrow("agents_record_invalid");
  expect(()=>readAgentState({...state,missions:[{...state.missions[0]!,usage:{...state.missions[0]!.usage,modelCalls:state.invocations.length}}]})).toThrow("agents_record_invalid");
});
