import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createAgentApplication } from "../agents/application-service.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";
import { agentApplicationFixture, returnedWorkDecision, applicationPlan, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const id="agent-a";

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test(`${policy} automatically selects dialogue and work using the existing controller`, {timeout:20_000}, async () => {
    const f = await agentApplicationFixture({policy, choose(state) {
      const mission=state.missions.at(-1)!;
      if (mission.objective === "How would you compare these monitors?") return applicationPlan("answer_user");
      const attempt=state.attempts.find((entry) => entry.missionId===mission.id);
      return attempt ? returnedWorkDecision() : applicationPlan("start_session");
    }});
    const conversation={messageId:"discuss",text:"How would you compare these monitors?",intent:"auto" as const};
    await f.app.send(id,conversation);await f.app.whenIdle();
    const discussion=await f.app.detail(id);
    expect(discussion.mission?.status).toBe("completed");expect(discussion.responsibility.map((entry)=>entry.plan.action)).toEqual(["answer_user"]);
    expect(discussion.mission?.usage.modelCalls).toBe(policy==="execution-agent-v1"?2:3);expect(f.run).not.toHaveBeenCalled();
    const selection=f.invoke.mock.calls.find(([input])=>input.format)![0];
    const messages=selection.messages as ChatMessage[];
    expect(JSON.parse(messages[1]!.content).mission.acceptedMode).toBe("auto");
    expect(messages.filter((entry)=>entry.role==="user"&&entry.content===conversation.text)).toHaveLength(1);
    await f.app.send(id,{messageId:"work",text:"Search for a monitor at a verified price.",intent:"auto"});await f.app.whenIdle();
    expect(f.run).toHaveBeenCalledOnce();expect((await f.app.detail(id)).mission?.status).toBe("completed");
    const calls=f.invoke.mock.calls.length;const restored=trackAgentApplication(createAgentApplication(f.dependencies));await restored.send(id,conversation);
    expect(f.invoke).toHaveBeenCalledTimes(calls);await expect(restored.send(id,{...conversation,intent:"task"})).rejects.toMatchObject({code:"agents_message_identity_conflict"});
  });
}

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test(`${policy} reads the exact saved result for a recap and can run newly requested research`, {timeout:20_000}, async () => {
    const research = "Find sources comparing three agent architectures.";
    const recap = "סכם לי שוב";
    const fresh = "Check the latest sources in a new work session.";
    const f = await agentApplicationFixture({policy, choose(state) {
      const mission = state.missions.at(-1)!;
      if (mission.objective === recap) {
        const read = state.responsibility.some((trace) => trace.missionId === mission.id && trace.plan.action === "read_evidence");
        return read ? applicationPlan("answer_user") : applicationPlan("read_evidence", {sessionId:state.sessions[0]!.sessionId});
      }
      const attempt = state.attempts.find((entry) => entry.missionId === mission.id);
      return attempt ? returnedWorkDecision() : applicationPlan("start_session");
    }});
    await f.app.send(id, {messageId:"research",text:research,intent:"auto"});
    await f.app.whenIdle();
    const original = (await f.app.detail(id)).attempts[0]!;

    f.invoke.mockClear();
    await f.app.send(id, {messageId:"recap",text:recap,intent:"auto"});
    await f.app.whenIdle();
    const detail = await f.app.detail(id);
    const actions = detail.responsibility.filter((trace) => trace.missionId === detail.mission!.id);
    expect(actions.map((trace) => trace.plan.action)).toEqual(["read_evidence", "answer_user"]);
    expect(detail.mission).toMatchObject({status:"completed",usage:{attempts:0}});
    expect(f.run).toHaveBeenCalledOnce();
    for (const [call] of f.invoke.mock.calls) {
      const context = call.messages as ChatMessage[];
      expect(context.filter((message) => message.role === "user")).toEqual([{role:"user",content:recap}]);
      const history = context.slice(2, -1);
      expect(history.map(message => message.role)).toEqual(["system"]);
      expect(JSON.parse(history[0]!.content)).toMatchObject({
        kind: "agent_conversation_history_v1", authority: "prior_dialogue_only", forMessageId: "recap",
        entries: expect.arrayContaining([
          expect.objectContaining({ id: "research", missionId: original.missionId, role: "user", text: research }),
        ]),
      });
    }
    const author = f.invoke.mock.calls.at(-1)![0].messages as ChatMessage[];
    expect(JSON.parse(author[1]!.content).evidence).toEqual([expect.objectContaining({
      id:original.id,sessionId:original.request.sessionId,text:completedAgentWork.output,
    })]);

    await f.app.send(id, {messageId:"new-work",text:fresh,intent:"auto"});
    await f.app.whenIdle();
    const newAttempt = (await f.app.detail(id)).attempts.at(-1)!;
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(newAttempt.mode).toBe("new");
    expect(newAttempt.request.sessionId).not.toBe(original.request.sessionId);
  });
}

test("the next automatic message answers exactly the outstanding question and preserves the budget", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({choose:state=>state.messages.some((entry)=>entry.inReplyTo)?applicationPlan("answer_user"):applicationPlan("ask_user")});
  await f.app.send(id,{messageId:"ambiguous",text:"Perhaps we should look at monitors",intent:"auto"});await f.app.whenIdle();
  const waiting=await f.app.detail(id),question=waiting.messages.at(-1)!;expect(question.purpose).toBe("question");expect(waiting.pendingUserQuestionId).toBe(question.id);
  const response={messageId:"clarify",text:"Just explain what to consider.",intent:"auto" as const};
  await Promise.all([f.app.send(id,response),f.app.send(id,response)]);await f.app.whenIdle();
  const resolved=await f.app.detail(id);expect(resolved.mission).toMatchObject({id:waiting.mission!.id,status:"completed",limits:waiting.mission!.limits,usage:{clarificationRounds:1}});
  expect(resolved.pendingUserQuestionId).toBeNull();expect(resolved.messages.filter((entry)=>entry.inReplyTo===question.id)).toHaveLength(1);
  expect(resolved.messages.find((entry)=>entry.id===response.messageId)).toMatchObject({purpose:"clarification",inputIntent:"auto",inReplyTo:question.id});
  expect(resolved.responsibility.map((entry)=>entry.plan.action)).toEqual(["ask_user","answer_user"]);expect(f.run).not.toHaveBeenCalled();
  const projected=f.invoke.mock.calls.at(-1)![0].messages as ChatMessage[];expect(projected.filter((entry)=>entry.role==="user"&&entry.content===response.text)).toHaveLength(1);
  await expect(f.store.commitApplication({kind:"open_agent_turn",agentId:id,missionId:"stale",messageId:"second-answer",text:"Replace the first answer",intent:"auto",source:null,limits:agentMissionLimits(),questionId:question.id})).rejects.toMatchObject({code:"agents_question_already_answered"});
});

test("automatic messages during approval or unknown usage cannot authorize continuation", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture({result:{...completedAgentWork,status:"awaiting_approval",usage:null}});
  await f.app.send(id,{messageId:"work",text:"Verify the price",intent:"auto"});await f.app.whenIdle();const before=(await f.app.detail(id)).mission!;
  await f.app.send(id,{messageId:"casual",text:"Go on",intent:"auto"});await f.app.whenIdle();
  let detail=await f.app.detail(id);expect(detail.status).toBe("awaiting_approval");expect(detail.mission?.revision).toBe(before.revision);expect(detail.messages.find((entry)=>entry.id==="casual")).toMatchObject({purpose:"conversation",inputIntent:"auto"});
  f.inspect.mockResolvedValue({...completedAgentWork,status:"unknown",usage:null});await f.app.refresh(id);detail=await f.app.detail(id);expect(detail.recovery.requiresNewBudget).toBe(true);
  const paused=detail.mission!;await f.app.send(id,{messageId:"still-chat",text:"Continue the search",intent:"auto"});await f.app.whenIdle();
  expect((await f.app.detail(id)).mission).toMatchObject({id:paused.id,revision:paused.revision,status:"awaiting_user_decision"});expect(f.run).toHaveBeenCalledOnce();
});

test("two overlapping standalone conversations each get one metered reply and close their shared turn",{timeout:20_000},async()=>{
  const f=await agentApplicationFixture();
  let release!:()=>void;const wait=new Promise<void>((resolve)=>{release=resolve;});
  f.invoke.mockImplementation(async(input)=>{await wait;return {text:`Reply to ${(input.messages as ChatMessage[]).at(-1)!.content}`,meta:{usage:{inputTokens:3,outputTokens:1,totalTokens:4}}};});
  try {
    await Promise.all([f.app.send(id,{messageId:"one",text:"First question",intent:"message"}),f.app.send(id,{messageId:"two",text:"Second question",intent:"message"})]);
    await vi.waitFor(()=>expect(f.invoke).toHaveBeenCalledOnce(),{timeout:5000});
  } finally {release();}
  await f.app.whenIdle();const state=await f.store.read();expect(state.missions).toHaveLength(1);expect(state.missions[0]).toMatchObject({status:"completed",usage:{modelCalls:2,totalTokens:8,attempts:0}});
  const firstAccepted = state.messages.find((entry)=>entry.role==="user")!;
  const other = state.messages.find((entry)=>entry.role==="user"&&entry.id!==firstAccepted.id)!;
  const firstContext=f.invoke.mock.calls.map(([input])=>input.messages as ChatMessage[]).find((messages)=>messages.at(-1)?.content===firstAccepted.text)!;
  expect(JSON.stringify(firstContext)).not.toContain(other.text);
  expect(state.messages.filter((entry)=>entry.role==="assistant").map((entry)=>entry.id).sort()).toEqual(["reply:one","reply:two"]);expect(state.responsibility).toHaveLength(0);expect(f.run).not.toHaveBeenCalled();
});

test("explicit retry of a legacy rejected Conversation answers the original message with the supplied clarification",{timeout:20_000},async()=>{
  const f=await agentApplicationFixture();
  await f.store.commitApplication({kind:"open_agent_turn",agentId:id,missionId:"old",messageId:"original",text:"Discuss the monitor options",intent:"message",source:null,limits:agentMissionLimits()});
  await f.store.commitApplication({kind:"mark_agent_waiting",agentId:id,missionId:"old",reason:"agents_plan_rejected_conversation_cannot_dispatch"});
  await f.app.recover();expect(f.invoke).not.toHaveBeenCalled();
  await f.app.resolve(id,{action:"continue",text:"I only want an explanation"});await f.app.whenIdle();const detail=await f.app.detail(id);
  expect(detail.mission?.status).toBe("completed");expect(detail.messages.at(-1)).toMatchObject({id:"reply:original"});expect(f.invoke).toHaveBeenCalledOnce();expect(f.invoke.mock.calls[0]![0].format).toBeUndefined();
  const messages=f.invoke.mock.calls[0]![0].messages as ChatMessage[];expect(messages.filter((item)=>item.role==="user").map((item)=>item.content)).toEqual(["Discuss the monitor options","I only want an explanation"]);expect(f.run).not.toHaveBeenCalled();
});

test("unknown conversation usage requires explicit new limits and preserves conversation intent",{timeout:20_000},async()=>{
  const f=await agentApplicationFixture();f.invoke.mockResolvedValueOnce({text:"A response with missing accounting",meta:{}});
  await f.app.send(id,{messageId:"chat",text:"Explain monitors",intent:"message"});await f.app.whenIdle();expect((await f.app.detail(id)).recovery.requiresNewBudget).toBe(true);
  await expect(f.app.resolve(id,{action:"continue",text:"Please answer my question"})).rejects.toMatchObject({code:"agents_unknown_resolution_requires_limits"});
  await f.app.resolve(id,{action:"continue",text:"Please answer my question",limits:agentMissionLimits()});await f.app.whenIdle();const state=await f.store.read();
  expect(state.missions.map((entry)=>entry.status)).toEqual(["cancelled","completed"]);expect(state.invocations[0]?.status).toBe("usage_unknown");expect(state.responsibility).toEqual([]);expect(f.run).not.toHaveBeenCalled();
});

test("a durable clarification resumes after the old controller releases, and concurrent retry owners do not relaunch it",{timeout:20_000},async()=>{
  const f=await agentApplicationFixture({choose:state=>state.messages.some((entry)=>entry.inReplyTo)?applicationPlan("answer_user"):applicationPlan("ask_user")});
  const original=f.store.commitApplication.bind(f.store);
  let release!:()=>void,visible!:()=>void;
  const written=new Promise<void>((resolve)=>{visible=resolve;}),hold=new Promise<void>((resolve)=>{release=resolve;});
  vi.spyOn(f.store,"commitApplication").mockImplementation(async(command)=>{
    const state=await original(command);
    if(command.kind==="ask_agent_user"){visible();await hold;}
    return state;
  });
  const response={messageId:"quick",text:"Just explain it",intent:"auto" as const};
  await f.app.send(id,{messageId:"initial",text:"Can we consider this?",intent:"auto"});await written;
  const pending=f.app.send(id,response);
  try {
    await vi.waitFor(async()=>expect((await f.store.read()).messages.some((entry)=>entry.id==="quick")).toBe(true),{timeout:5000});
    const other=trackAgentApplication(createAgentApplication(f.dependencies));await other.send(id,response);expect((await other.detail(id)).mission?.status).toBe("active");
  } finally {release();}
  await pending;await f.app.whenIdle();const state=await f.store.read();expect(state.missions[0]?.status).toBe("completed");expect(state.invocations).toHaveLength(4);
  expect(state.messages.filter((entry)=>entry.inReplyTo)).toHaveLength(1);
  const receipt=await f.store.admitMessage({kind:"open_agent_turn",agentId:id,missionId:"other-caller",messageId:response.messageId,text:response.text,intent:"auto",limits:agentMissionLimits(),source:null});expect(receipt.changed).toBe(false);
});
