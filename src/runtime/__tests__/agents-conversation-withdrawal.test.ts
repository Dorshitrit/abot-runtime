import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentMessageInput, AgentWorkResult } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import { agentApplicationFixture, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures);
const agent = "agent-a";
const work: AgentMessageInput = {messageId:"request", text:"Check the draft against the live catalogue.", intent:"auto"};
const correction: AgentMessageInput = {messageId:"amend", text:"Stop checking the catalogue. I only need the shorter draft here.", intent:"auto"};
const amended = "Here is the shortened draft from our conversation.";
const schema = "persistent_agent_inflight_reply_v1";
const confirmation = {...completedAgentWork,status:"cancelled" as const,output:null,receiptId:"ordinary-cancel",
  usage:{modelCalls:1,totalTokens:23}} satisfies AgentWorkResult;
const overdue: AgentWorkResult = {...completedAgentWork,status:"failed",output:"Obsolete returned work.",
  error:"request_failed",usage:{modelCalls:2,totalTokens:41}};
const wait = {timeout:5000};

function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return {promise,resolve};
}
async function inFlight(disposition:"withdraw_work" | "reply", text = amended, holdDecision = false, limits?:AgentMessageInput["limits"]) {
  const result = deferred<AgentWorkResult>();
  const decide = deferred<void>();
  const f = await agentApplicationFixture({run:() => result.promise});
  // An ordinary provider can finish and deliver its old terminal observation even after cancellation.
  f.dependencies.work.run = (request,signal) => f.run(request,signal);
  f.dependencies.work.cancel.mockResolvedValue(confirmation);
  f.inspect.mockResolvedValue(confirmation);
  const previous = f.invoke.getMockImplementation()!;
  const answer = {text:JSON.stringify({disposition,text}),meta:{usage:{inputTokens:9,outputTokens:4,totalTokens:13}}};
  f.invoke.mockImplementation(async input => {
    if (typeof input.format === "object" && input.format?.name === schema) {
      if (holdDecision) await decide.promise;
      return answer;
    }
    return previous(input);
  });
  await f.app.send(agent,{...work,limits});
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce(),wait);
  const before = (await f.app.detail(agent)).mission!;
  const attempt = (await f.store.read()).attempts[0]!;
  const decisionCalls = () => f.invoke.mock.calls.map(([call]) => call)
    .filter(call => typeof call.format === "object" && call.format?.name === schema);
  return {f,before,attempt,result,decide,decisionCalls};
}

test("a direct correction cancels only its admitted ordinary attempt and durably publishes one model reply", async () => {
  const {f,before,attempt,result,decisionCalls} = await inFlight("withdraw_work");
  try {
    await Promise.all([f.app.send(agent,correction),f.app.send(agent,correction)]);
    await vi.waitFor(async () => expect((await f.store.read()).attempts[0]).toMatchObject({status:"settled",result:confirmation}),wait);
    // The outdated run promise delivers a conflicting terminal result after the cancellation receipt.
    result.resolve(overdue);
    await f.app.whenIdle();
    expect(f.dependencies.work.cancel).toHaveBeenCalledExactlyOnceWith(attempt.request);
    expect(decisionCalls()).toHaveLength(1);
    const messages = decisionCalls()[0]!.messages as ChatMessage[];
    const capsule = JSON.parse(messages[1]!.content);
    expect(capsule.currentWork).toMatchObject({attemptId:attempt.id, assignment:attempt.request.assignment, omittedCharacters:0});
    expect(messages.filter(entry => entry.role === "user").map(entry => entry.content)).toEqual([correction.text]);
    const state = await f.store.read();
    expect(state.messages.find(record => record.id === correction.messageId)).toMatchObject({correctableAttemptId:attempt.id});
    expect(state.messages.filter(record => record.role === "assistant")).toMatchObject([
      {id:"reply:amend",text:amended,withdrawnAttemptId:attempt.id}]);
    expect(state.missions[0]).toMatchObject({id:before.id,status:"cancelled",usage:{
      attempts:before.usage.attempts, modelCalls:before.usage.modelCalls+2,totalTokens:before.usage.totalTokens+13+23}});
    expect(state.attempts[0]).toMatchObject({id:attempt.id,result:confirmation});
    const calls = f.invoke.mock.calls.length;
    await f.app.shutdown();
    const store = new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir,"agents","state.json"));
    const reopened = trackAgentApplication(createAgentApplication({...f.dependencies,store}));
    await reopened.recover();
    await reopened.send(agent,correction);
    await reopened.whenIdle();
    expect((await store.read()).messages).toEqual(state.messages);
    expect((await store.read()).missions[0]?.usage).toEqual(state.missions[0]?.usage);
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    expect(f.dependencies.work.cancel).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  } finally { result.resolve(overdue); }
},20_000);

test.each([
  {intent:"auto" as const,text:"What did you mean by catalogue?",reply:"It is the source the draft is being checked against."},
  {intent:"auto" as const,text:"Just the earlier one, perhaps?",reply:"Do you want me to stop the check, or are you asking about the earlier draft?"},
  {intent:"message" as const,text:correction.text,reply:"I am checking the evidence. Your new question did not change the task."},
])("an independent $intent message keeps its original work active: $text", async ({intent,text,reply}) => {
  const {f,before,result,decisionCalls} = await inFlight("reply",reply);
  try {
    await f.app.send(agent,{messageId:"aside",text,intent});
    await vi.waitFor(async () => expect((await f.store.read()).messages.at(-1)).toMatchObject({id:"reply:aside",text:reply}),wait);
    const state = await f.store.read();
    expect(state.missions[0]).toMatchObject({id:before.id,status:"active",revision:before.revision});
    expect(state.messages.at(-1)).not.toHaveProperty("withdrawnAttemptId");
    expect(f.dependencies.work.cancel).not.toHaveBeenCalled();
    expect(decisionCalls()).toHaveLength(intent === "auto" ? 1 : 0);
    if (intent === "message") {
      expect(state.messages.find(entry => entry.id === "aside")).not.toHaveProperty("correctableAttemptId");
      expect(f.invoke.mock.calls.at(-1)![0].format).toBeUndefined();
    }
  } finally {
    result.resolve(completedAgentWork);
    await f.app.whenIdle();
  }
},20_000);

test("an attempt settling during correction authoring cannot post its obsolete answer ahead of the accepted correction", async () => {
  const {f,before,attempt,result,decide,decisionCalls} = await inFlight("withdraw_work",amended,true);
  try {
    await f.app.send(agent,correction);
    await vi.waitFor(() => expect(decisionCalls()).toHaveLength(1),wait);
    result.resolve(overdue);
    await vi.waitFor(async () => expect((await f.store.read()).attempts[0]).toMatchObject({status:"settled",result:overdue}),wait);
    decide.resolve();
    await f.app.whenIdle();
    const state = await f.store.read();
    expect(state.missions[0]).toMatchObject({id:before.id,status:"cancelled"});
    expect(state.messages.filter(record => record.role === "assistant")).toMatchObject([
      {id:"reply:amend",text:amended,withdrawnAttemptId:attempt.id}]);
    expect(f.dependencies.work.cancel).not.toHaveBeenCalled();
    expect(f.createSession).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  } finally {
    result.resolve(overdue);
    decide.resolve();
  }
},20_000);

test.each(["invalid output","provider failure","exhausted call allowance"] as const)(
  "an unavailable correction reply after %s preserves the run and exposes a durable unanswered status", async failure => {
  const limits = failure === "exhausted call allowance" ? {...agentMissionLimits(),maxModelCalls:3} : undefined;
  const {f,before,result,decisionCalls} = await inFlight("withdraw_work",amended,false,limits);
  try {
    if (limits) {
      await f.app.send(agent,{intent:"message",messageId:"use-last-call",text:"How is it going?"});
      await vi.waitFor(async () => expect((await f.store.read()).messages.at(-1)?.id).toBe("reply:use-last-call"),wait);
      expect((await f.store.read()).missions[0]?.usage.modelCalls).toBe(limits.maxModelCalls);
    } else {
      const previous = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation(async input => {
        if (typeof input.format !== "object" || input.format?.name !== schema) return previous(input);
        if (failure === "provider failure") throw new Error("Fixture provider unavailable");
        return {text:'{"disposition":"withdraw_work","text":42}',meta:{usage:{inputTokens:9,outputTokens:4,totalTokens:13}}};
      });
    }
    const prior = await f.store.read();
    await f.app.send(agent,correction);
    await vi.waitFor(async () => {
      const detail = await f.app.detail(agent);
      expect(detail.replyingToMessageIds).toEqual([]);
      expect(detail.recovery.unansweredUpdateId).toBe(correction.messageId);
    },wait);
    const state = await f.store.read();
    expect(state.missions[0]).toMatchObject({id:before.id,status:"active",revision:before.revision});
    expect(state.messages.slice(prior.messages.length)).toMatchObject([{id:correction.messageId,role:"user",text:correction.text}]);
    expect(decisionCalls()).toHaveLength(limits ? 0 : 1);
    expect(state.invocations).toHaveLength(prior.invocations.length+(limits ? 0 : 1));
    expect(f.dependencies.work.cancel).not.toHaveBeenCalled();
    const store = new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir,"agents","state.json"));
    const reopened = trackAgentApplication(createAgentApplication({...f.dependencies,store}));
    expect((await reopened.detail(agent)).recovery.unansweredUpdateId).toBe(correction.messageId);
    await reopened.send(agent,correction);
    expect((await store.read()).messages).toEqual(state.messages);
  } finally {
    result.resolve(completedAgentWork);
    await f.app.whenIdle();
  }
},20_000);

test("recovery reconciles the exact ordinary request if the process dies after saving the correction and before recording cancellation", async () => {
  const {f,before,attempt,result} = await inFlight("withdraw_work");
  const cancellation = deferred<typeof confirmation>();
  f.dependencies.work.cancel.mockImplementation(() => cancellation.promise);
  try {
    await f.app.send(agent,correction);
    await vi.waitFor(() => expect(f.dependencies.work.cancel).toHaveBeenCalledOnce(),wait);
    const agentDir = join(f.dependencies.config.paths.runtimeDir,"agents");
    const crashFile = join(agentDir,"interrupted-state.json");
    await copyFile(join(agentDir,"state.json"),crashFile);
    const store = new FileAgentStateStore(crashFile);
    const snapshot = await store.read();
    expect(snapshot.missions[0]?.status).toBe("cancelled");
    expect(snapshot.attempts[0]?.status).not.toBe("settled");
    const calls = f.invoke.mock.calls.length;
    const inspect = vi.fn(async () => overdue);
    const cancel = vi.fn(async () => confirmation);
    const reopened = trackAgentApplication(createAgentApplication({...f.dependencies,store,work:{...f.dependencies.work,inspect,cancel}}));
    await reopened.recover();
    await reopened.send(agent,correction);
    await reopened.recover();
    await reopened.whenIdle();
    expect(inspect).toHaveBeenCalledExactlyOnceWith(attempt.request);
    expect(cancel).not.toHaveBeenCalled();
    const state = await store.read();
    expect(state.messages).toEqual(snapshot.messages);
    expect(state.attempts[0]).toMatchObject({id:attempt.id,status:"settled",result:overdue});
    expect(state.missions[0]).toMatchObject({id:before.id,status:"cancelled",usage:{
      modelCalls:before.usage.modelCalls+3,totalTokens:before.usage.totalTokens+13+41}});
    expect(f.invoke).toHaveBeenCalledTimes(calls);
  } finally {
    cancellation.resolve(confirmation);
    result.resolve(confirmation);
    await f.app.whenIdle();
  }
},20_000);
