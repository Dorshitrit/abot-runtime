import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentApplicationService, AgentWorkResult } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import { reduceAgentCommand } from "../agents/state-reducer.js";
import { projectAgentContext } from "../agents/context-projection.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";
import { agentApplicationFixture, returnedWorkDecision, applicationPlan, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
afterEach(disposeAgentApplicationFixtures,20_000);
const answer="Use the user-selected fictional source A.";
async function fixture(options:{reply?:"malformed"|"unknown_usage"|"needs_user";repeat?:boolean;work?:()=>Promise<AgentWorkResult>;onReply?:(app:AgentApplicationService)=>Promise<void>;noQuestion?:boolean}={}) {
  const f=await agentApplicationFixture({...(options.work?{run:options.work}:{})}),definition=(await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({kind:"update_definition",agentId:"agent-a",definition:{...definition,defaultLimits:{...agentMissionLimits(),maxClarificationRounds:1}}});
  await f.store.commitApplication({kind:"register_agent",agentId:"abot",definition:{...definition,name:"ABot",basePrompt:"PRIVATE_COORDINATOR_STANDING_PROMPT",defaultLimits:{...agentMissionLimits(),maxModelCalls:40,maxTotalTokens:50000}}});
  let app!:AgentApplicationService;const coordination=createAgentCoordinationPort({store:f.store,application:()=>app});app=trackAgentApplication(createAgentApplication({...f.dependencies,...coordination}));
  let replyCalls=0;
  f.invoke.mockImplementation(async(input)=>{
    const messages=input.messages as ChatMessage[],capsule=JSON.parse(messages[1]!.content),state=await f.store.read(),mission=state.missions.find((entry)=>entry.id===capsule.mission.id)!;
    if(input.format&&JSON.stringify(input.format).includes('"needs_user"')) {
      replyCalls++;
      expect(JSON.stringify(messages)).not.toContain("PRIVATE_COORDINATOR_STANDING_PROMPT");expect(JSON.stringify(messages)).not.toContain("PRIVATE_PRIOR_PARENT_FACT");
      await options.onReply?.(app);
      return {text:options.reply==="malformed"?"Confident but malformed":JSON.stringify({action:options.reply==="needs_user"?"needs_user":"answer",text:answer}),meta:options.reply==="unknown_usage"?{}:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
    }
    const attempt=state.attempts.find((entry)=>entry.missionId===mission.id),exchange=state.mailbox.find((entry)=>entry.missionId===mission.id),received=state.messages.some((entry)=>entry.missionId===mission.id&&entry.text===answer);
    const plan=mission.objective==="PRIVATE_PRIOR_PARENT_FACT"?applicationPlan("answer_user"):mission.agentId==="abot"?(exchange?applicationPlan("complete",{evidenceIds:[exchange.id],metCriteriaIds:["request"]}):applicationPlan("delegate_agent",{recipientAgentId:"agent-a"})):(attempt?returnedWorkDecision():(received&&!options.repeat||options.noQuestion)?applicationPlan("start_session"):applicationPlan("ask_user"));
    return {text:input.format?JSON.stringify({decision:plan}):plan.action==="ask_user"?"Which source should I use?":"Check the explicitly selected source.",meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
  });
  return {...f,app,replies:()=>replyCalls};
}
async function begin(f:Awaited<ReturnType<typeof fixture>>) {await f.app.send("abot",{messageId:"task",text:"Verify fictional source A",intent:"task"});}

async function beginThroughQuestionReply(f: Awaited<ReturnType<typeof fixture>>) {
  const answerQuestion = f.app.answerPeerClarification.bind(f.app);
  let observeReply!: (result: ReturnType<typeof answerQuestion>) => void;
  const handled = new Promise<Awaited<ReturnType<typeof answerQuestion>>>((resolve) => { observeReply = resolve; });
  vi.spyOn(f.app, "answerPeerClarification").mockImplementation((request) => {
    const result = answerQuestion(request);
    observeReply(result);
    return result;
  });
  await begin(f);
  expect(await handled).toBe("awaiting_user_decision");
}

test("the reply loan returns unused allowance, charges once and never promotes a peer answer to user authority",{timeout:20_000},async()=>{
  const f=await fixture();await f.app.send("abot",{messageId:"private-parent",text:"PRIVATE_PRIOR_PARENT_FACT",intent:"message"});await f.app.whenIdle("abot");await begin(f);await f.app.whenIdle("abot");
  const state=await f.store.read(),exchange=state.mailbox[0]!,record=exchange.clarifications![0]!,child=state.missions.find((entry)=>entry.id===record.childMissionId)!,parent=state.missions.find((entry)=>entry.id===exchange.missionId)!;
  expect(record).toMatchObject({status:"answered",usageTokens:10});expect(f.replies()).toBe(1);expect(child.limits).toMatchObject({maxModelCalls:23,maxTotalTokens:19990});
  expect(parent.usage.modelCalls).toBe(state.invocations.filter((entry)=>entry.missionId===parent.id).length+child.usage.modelCalls);
  expect(parent.usage.totalTokens).toBe(state.invocations.filter((entry)=>entry.missionId===parent.id).length*10+child.usage.totalTokens);
  const messages=projectAgentContext({state,agentId:child.agentId,missionId:child.id,instructions:"Inspect context"});expect(messages.some((entry)=>entry.role==="user"&&entry.content===answer)).toBe(false);expect(messages.some((entry)=>entry.role==="system"&&entry.content.includes("accepted_coordinator_clarification")&&entry.content.includes(answer))).toBe(true);
  const request={parentAgentId:"abot",childAgentId:child.agentId,childMissionId:child.id,exchangeId:exchange.id,questionMessageId:record.questionMessageId,signal:new AbortController().signal};
  expect(await f.app.answerPeerClarification(request)).toBe("answered");expect(f.replies()).toBe(1);
  await expect(f.app.answerPeerClarification({...request,childMissionId:"foreign"})).rejects.toMatchObject({code:"agents_peer_question_invalid"});
});

for(const reply of ["malformed","unknown_usage"] as const)test(`${reply} freezes both participants and restart never repeats the coordinator call`,{timeout:20_000},async()=>{
  const f = await fixture({ reply });
  await beginThroughQuestionReply(f);
  const state=await f.store.read(),exchange=state.mailbox[0]!,record=exchange.clarifications![0]!;
  expect(record.status).toBe("unknown");
  expect((await f.app.detail("abot")).status).toBe("awaiting_user_decision");expect((await f.app.detail(record.childAgentId)).status).toBe("awaiting_user_decision");
  expect((await f.app.detail(record.childAgentId)).recovery.requiresNewBudget).toBe(true);expect(f.run).not.toHaveBeenCalled();
  if(reply==="unknown_usage")expect(state.invocations.find((entry)=>entry.id===record.invocationId)).toMatchObject({status:"usage_unknown",usage:null,reservedTokens:record.reservedTokens});
  const restored=trackAgentApplication(createAgentApplication(f.dependencies));await restored.recover();
  expect(await restored.answerPeerClarification({parentAgentId:"abot",childAgentId:record.childAgentId,childMissionId:record.childMissionId,exchangeId:exchange.id,questionMessageId:record.questionMessageId,signal:new AbortController().signal})).toBe("awaiting_user_decision");expect(f.replies()).toBe(1);
  await f.app.cancel("abot");await f.app.whenIdle();
});

test("a child cannot exceed the agreed clarification-round limit",{timeout:20_000},async()=>{
  const f=await fixture({repeat:true});await begin(f);await f.app.whenIdle("abot");const state=await f.store.read(),exchange=state.mailbox[0]!;
  expect(exchange.clarifications).toHaveLength(1);expect(f.replies()).toBe(1);expect(state.messages.filter((entry)=>entry.purpose==="question")).toHaveLength(1);expect(f.run).not.toHaveBeenCalled();expect(exchange.outcome).toBe("exhausted");
});

test("deleting a retired delegate retains the coordinator reply, evidence binding and charges", {timeout:20_000}, async () => {
  const f = await fixture();
  await begin(f);
  await f.app.whenIdle("abot");
  const before = await f.store.read();
  const child = "agent-a";
  const receipt = before.mailbox[0]!;
  expect(receipt.clarifications).toHaveLength(1);
  const {clarifications, ...retained} = receipt;
  const uncertain = {...before, mailbox:[{...receipt, status:"unknown" as const, usage:null, outcome:null}]};
  expect(() => reduceAgentCommand(uncertain, {kind:"begin_agent_deletion", agentId:child}, receipt.updatedAt)).toThrow("agents_deletion_unresolved");
  const pending = await f.store.beginDeletion(child, before.revision);
  const lateDelivery = {kind:"prepare_agent_exchange" as const, agentId:"abot", record:{...receipt, id:"late-delivery"}};
  await expect(f.store.commitApplication(lateDelivery)).rejects.toThrow("agents_deletion_pending");
  expect(pending.sessions.some(session => session.agentId === child)).toBe(true);
  await f.store.finishDeletion(child);
  const deleted = await f.store.read();
  expect(deleted.mailbox).toEqual([retained]);
  await expect(f.store.commitApplication(lateDelivery)).rejects.toThrow("agents_agent_not_found");
  expect(deleted.responsibility).toEqual(before.responsibility.filter(trace => trace.agentId === "abot"));
  expect(deleted.missions).toEqual(before.missions.filter(mission => mission.agentId === "abot"));
  expect(deleted.messages).toEqual(before.messages.filter(message => message.agentId === "abot"));
  expect(deleted.invocations).toEqual(before.invocations.filter(call => call.agentId === "abot"));
  expect(deleted.attempts).toEqual([]); expect(deleted.sessions).toEqual([]);
  expect(deleted.decisions.every(decision => decision.agentId === "abot")).toBe(true);
});

test("a user conversation during delegation saves a canonical reply without pausing the parent",{timeout:20_000},async()=>{
  let release!:(value:AgentWorkResult)=>void;
  const f=await fixture({noQuestion:true,work:()=>new Promise((resolve)=>{release=resolve;})});await begin(f);await vi.waitFor(()=>expect(f.run).toHaveBeenCalledOnce(),{timeout:5000});
  try {
    const before=(await f.app.detail("abot")).mission!;const calls=f.invoke.mock.calls.length;
    await f.app.send("abot",{messageId:"status-chat",text:"How is the delegated work going?",intent:"message"});
    await vi.waitFor(async()=>expect((await f.app.detail("abot")).messages.some((entry)=>entry.id==="reply:status-chat")).toBe(true),{timeout:5000});
    const after=(await f.app.detail("abot")).mission!;expect(after.status).toBe("active");expect(after.revision).toBe(before.revision);expect(f.invoke).toHaveBeenCalledTimes(calls);
  } finally {release(completedAgentWork);}
  await f.app.whenIdle("abot");
});

test("child conversation during a reserved clarification loan cannot change the waiting mission or spend the reservation",{timeout:20_000},async()=>{
  let checked=false;
  const f=await fixture({onReply:async(app)=>{
    const before=(await app.detail("agent-a")).mission!;
    await app.send("agent-a",{messageId:"loan-chat",text:"What are you waiting for?",intent:"message"});
    await vi.waitFor(async()=>expect((await app.detail("agent-a")).messages.some((entry)=>entry.id==="reply:loan-chat")).toBe(true),{timeout:5000});
    const after=(await app.detail("agent-a")).mission!;expect(after.status).toBe(before.status);expect(after.revision).toBe(before.revision);expect(after.usage).toEqual(before.usage);checked=true;
  }});
  await begin(f);await f.app.whenIdle("abot");expect(checked).toBe(true);expect((await f.app.detail("abot")).mission?.status).toBe("completed");
});

test("needs_user preserves known accounting and an explicit user answer resumes the same child task",{timeout:20_000},async()=>{
  const f = await fixture({ reply:"needs_user" });
  await beginThroughQuestionReply(f);
  const state=await f.store.read(),record=state.mailbox[0]!.clarifications![0]!,before=(await f.app.detail(record.childAgentId)).mission!;
  expect(record.status).toBe("awaiting_user_decision");
  expect((await f.app.detail("abot")).mission?.status).toBe("active");expect((await f.app.detail(record.childAgentId)).recovery.requiresNewBudget).toBe(false);
  await f.app.resolve(record.childAgentId,{action:"continue",text:answer});await f.app.whenIdle("abot");
  const after=(await f.app.detail(record.childAgentId)).mission!;expect(after.id).toBe(before.id);expect(after.limits).toEqual(before.limits);expect(after.status).toBe("completed");expect(f.replies()).toBe(1);expect(f.run).toHaveBeenCalledOnce();
});

test("a crash during the reserved coordinator call freezes the loan and cannot replay the question",{timeout:20_000},async()=>{
  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>((resolve)=>{entered=resolve;}),gate=new Promise<void>((resolve)=>{release=resolve;});
  const f=await fixture({onReply:async()=>{entered();await gate;}});await begin(f);await ready;
  try {
    const before=await f.store.read(),exchange=before.mailbox[0]!,record=exchange.clarifications![0]!;expect(record.status).toBe("reserved");
    const restored=trackAgentApplication(createAgentApplication(f.dependencies));await restored.recover();
    const recovered=await f.store.read();expect(recovered.mailbox[0]?.clarifications?.[0]).toMatchObject({status:"unknown",usageTokens:null});
    expect((await restored.detail(record.childAgentId)).recovery.requiresNewBudget).toBe(true);
    expect(await restored.answerPeerClarification({parentAgentId:"abot",childAgentId:record.childAgentId,childMissionId:record.childMissionId,exchangeId:exchange.id,questionMessageId:record.questionMessageId,signal:new AbortController().signal})).toBe("awaiting_user_decision");expect(f.replies()).toBe(1);expect(f.run).not.toHaveBeenCalled();
  } finally {release();}
  await f.app.cancel("abot");await f.app.whenIdle();
});
