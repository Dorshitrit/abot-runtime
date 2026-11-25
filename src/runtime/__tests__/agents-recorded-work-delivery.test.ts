import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readAgentState } from "../agents/state-validation.js";
import { recordedWorkReplyCommand } from "../agents/workspace-evidence.js";
import { agentApplicationFixture, applicationPlan, completedAgentWork, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);

async function measuredWork(output: string | null = completedAgentWork.output) {
  const f = await agentApplicationFixture({result:{...completedAgentWork,status:"running",output:null,usage:null}});
  await f.app.send("agent-a", {messageId:"request",text:"Find an available replacement.",intent:"task"});
  await f.app.whenIdle();
  const attempt = (await f.store.read()).attempts[0]!;
  const state = await f.store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId:attempt.id,result:{...completedAgentWork,output}});
  return {f, state, mission:state.missions[0]!, attempt:state.attempts[0]!};
}

describe("delivery from an existing public work result", () => {
  test("an old rejected direct answer delivers the exact cited model result once on reopening without any execution", async () => {
    const text = "One possible match.\nShipping remains unverified.";
    const {f, state, mission, attempt} = await measuredWork(text);
    const earlier = state.invocations[0]!;
    await f.store.commitApplication({kind:"reserve_invocation",agentId:"agent-a",missionId:mission.id,agentRevision:earlier.agentRevision,
      missionRevision:mission.revision,invocationId:"old-selection",configuration:earlier.configuration,stage:"assessment_and_selection",reservedTokens:10});
    await f.store.commitApplication({kind:"settle_invocation",agentId:"agent-a",invocationId:"old-selection",usage:{totalTokens:5,cost:{kind:"unknown"}}});
    const paused = await f.store.commitApplication({kind:"mark_agent_waiting",agentId:"agent-a",missionId:mission.id,reason:"agents_plan_rejected_work_requires_acceptance"});
    const rejected = {...paused.responsibility[0]!,id:"old-rejection",invocationId:"old-selection",accepted:false,code:"work_requires_acceptance",
      plan:applicationPlan("answer_user",{evidenceIds:[attempt.id]}),createdAt:paused.missions[0]!.updatedAt};
    const snapshot = readAgentState({...paused,responsibility:[...paused.responsibility,rejected]});
    await writeFile(join(f.dependencies.config.paths.runtimeDir,"agents","state.json"),JSON.stringify(snapshot));
    const known = recordedWorkReplyCommand(snapshot,snapshot.missions[0]!,snapshot.missions[0]!.waitingReason!)!;
    expect(known.attemptId).toBe(attempt.id);
    const uncited = {...rejected,plan:{...rejected.plan,evidenceIds:["other"]}};
    expect(recordedWorkReplyCommand({...snapshot,responsibility:[...paused.responsibility,uncited]},snapshot.missions[0]!,known.reason)).toBeUndefined();
    f.invoke.mockClear(); f.run.mockClear(); f.inspect.mockClear(); f.createSession.mockClear();
    await Promise.all([f.app.recover(),f.app.recover()]);
    const recovered=await f.store.read();
    expect(recovered.missions[0]).toMatchObject({status:"completed",waitingReason:null,usage:snapshot.missions[0]!.usage});
    expect(recovered.messages.filter(entry=>entry.purpose==="reply").map(entry=>entry.text)).toEqual([text]);
    expect(recovered.responsibility).toEqual(snapshot.responsibility);
    await f.app.recover(); await f.store.commitApplication(known);
    expect((await f.store.read()).revision).toBe(recovered.revision);
    expect(f.invoke).not.toHaveBeenCalled();expect(f.run).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();expect(f.createSession).not.toHaveBeenCalled();
  });

  test("a model answer beyond the chat limit survives reopening with its exact receipt, unrelated oversized messages remain invalid", async () => {
    const output = "🌍".repeat(36_000);
    const {f,state,mission,attempt}=await measuredWork(output);
    await f.store.commitApplication({kind:"append_agent_message",agentId:"agent-a",missionId:mission.id,
      messageId:"work-result:"+attempt.id,role:"user",purpose:"conversation",text:"Another message with a colliding ID."});
    const cmd=recordedWorkReplyCommand(state,mission,"agents_token_limit_reached")!;
    await f.store.commitApplication(cmd);
    const stored=await f.store.read(), message=stored.messages.at(-1)!;
    expect(stored.missions[0]?.status).toBe("exhausted");
    expect(message.text).toBe(output);
    expect((await f.app.detail("agent-a")).recovery.recordedWorkDelivery).toBe("output");
    expect(()=>readAgentState({...stored,messages:[...state.messages,{...message,text:output+"x"}]})).toThrow();
    expect(()=>readAgentState({...stored,messages:[...state.messages,{...message,role:"user"}]})).toThrow();
  });

  test("an empty terminal result reports the end of the task without inserting an assistant message", async () => {
    const {f,state,mission}=await measuredWork(null);
    const cmd=recordedWorkReplyCommand(state,mission,"agents_plan_invalid")!;
    await f.store.commitApplication(cmd);
    const detail=await f.app.detail("agent-a");
    expect(detail.mission?.status).toBe("exhausted");
    expect(detail.recovery.recordedWorkDelivery).toBe("empty");
    expect(detail.messages.filter(message=>message.role==="assistant")).toHaveLength(0);
  });

  test("known results cannot settle another mission, a user pause or an uncertain invocation",async()=>{
    const {f,state,mission}=await measuredWork();
    const cmd=recordedWorkReplyCommand(state,mission,"agents_model_call_limit_reached")!;
    const pending=state.invocations.map(record=>({...record,status:"usage_unknown" as const,usage:null}));
    expect(recordedWorkReplyCommand({...state,invocations:pending},mission,cmd.reason)).toBeUndefined();
    expect(recordedWorkReplyCommand(state,mission,"agents_interrupted")).toBeUndefined();
    const wrong=await f.store.commitApplication({...cmd,attemptId:"foreign"});
    expect(wrong.revision).toBe(state.revision);
    await f.app.pause("agent-a");
    const paused=await f.store.read();
    await f.store.commitApplication(cmd);
    expect((await f.store.read()).revision).toBe(paused.revision);
    expect((await f.app.detail("agent-a")).mission?.status).toBe("awaiting_user_decision");
  });
});
