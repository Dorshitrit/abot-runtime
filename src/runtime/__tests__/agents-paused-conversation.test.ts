import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createAgentApplication } from "../agents/application-service.js";
import { projectAgentContext } from "../agents/context-projection.js";
import { conversationInvocationId } from "../agents/conversation-intent.js";
import { agentApplicationFixture, applicationPlan, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const agent = "agent-a";
const followUp = {messageId:"side-question", intent:"auto" as const, text:"What did you find before the task paused?"};

test.each(["active", "completed"] as const)("a follow-up read at the %s revision can author one reply after work completes", async (snapshot) => {
  const f = await agentApplicationFixture();
  f.run.mockImplementationOnce(async (request) => {
    // Admit through the store and hold the side worker until the original work has published.
    const input = {kind:"open_agent_turn" as const, agentId:agent, missionId:request.missionId, text:"Update the draft from our conversation.", limits:null, source:null};
    await f.store.admitMessage({...input, messageId:"bound", intent:"auto"});
    await f.store.admitMessage({...input, messageId:"unbound", intent:"message"});
    return completedAgentWork;
  });
  await f.app.send(agent,{messageId:"task", intent:"auto", text:"Verify the draft against the catalogue."});
  await f.app.whenIdle();
  const state = await f.store.read();
  const mission = state.missions[0]!, attempt = state.attempts[0]!, receipt = state.invocations[0]!;
  expect(mission.status).toBe("completed");
  const reserve = (messageId:string, revision:number) => ({
    kind:"reserve_conversation_reply" as const, agentId:agent, missionId:mission.id, messageId, configuration:receipt.configuration,
    invocationId:conversationInvocationId(mission.id,messageId,attempt.agentRevision,revision), reservedTokens:1,
    agentRevision:attempt.agentRevision, missionRevision:revision,
  });
  await expect(f.store.commitApplication(reserve("unbound", mission.revision))).rejects.toMatchObject({code:"agents_mission_not_active"});
  const cmd = reserve("bound", snapshot === "active" ? attempt.missionRevision : mission.revision);
  const reserved = await f.store.commitApplication(cmd);
  expect(reserved.missions[0]).toMatchObject({status:"completed", revision:mission.revision, usage:{modelCalls:mission.usage.modelCalls+1}});
  await f.store.commitApplication({kind:"settle_invocation", agentId:agent, invocationId:cmd.invocationId, usage:{totalTokens:1,cost:{kind:"unknown"}}});
  await expect(f.store.commitApplication(reserve("bound", mission.revision))).rejects.toMatchObject({code:"agents_conversation_already_claimed"});
  const publish = {kind:"publish_conversation_reply" as const, agentId:agent, missionId:mission.id, messageId:"bound", invocationId:cmd.invocationId, text:"Here is the revised draft."};
  await expect(f.store.commitApplication({...publish, withdrawAttemptId:"other"})).rejects.toMatchObject({code:"agents_conversation_withdrawal_invalid"});
  const final = await f.store.commitApplication({...publish, withdrawAttemptId:attempt.id});
  expect(final.messages.at(-1)).toMatchObject({id:"reply:bound", text:publish.text});
  expect(final.messages.at(-1)).not.toHaveProperty("withdrawnAttemptId");
  expect(final.missions[0]).toMatchObject({status:"completed", revision:mission.revision, usage:{totalTokens:mission.usage.totalTokens+1}});
  expect(await f.store.commitApplication(publish)).toEqual(final);
}, 20_000);

async function pausedTask(maxModelCalls = 24) {
  const fixture = await agentApplicationFixture({ choose: state => applicationPlan(state.attempts.length ? "wait" : "start_session") });
  // Park on a genuine user pause after the work is recorded, before the next decision.
  const commit = fixture.store.commitApplication.bind(fixture.store);
  vi.spyOn(fixture.store, "commitApplication").mockImplementation(async command => {
    const next = await commit(command);
    if (command.kind === "observe_agent_work" && command.result.status === "completed") {
      const mission = next.missions.find(entry => entry.agentId === agent && entry.status === "active")!;
      return commit({ kind: "mark_agent_waiting", agentId: agent, missionId: mission.id, reason: "Paused by the user." });
    }
    return next;
  });
  await fixture.app.send(agent, {messageId:"work", intent:"auto", text:"Find a verified source.", limits:{...agentMissionLimits(), maxModelCalls}});
  await fixture.app.whenIdle();
  expect((await fixture.app.detail(agent)).mission?.waitingReason).toBe("Paused by the user.");
  return fixture;
}

test("a paused task answers the exact question from its saved evidence after restart without another work attempt", async () => {
  const f = await pausedTask();
  const before = (await f.app.detail(agent)).mission!;
  const state = await f.store.read();
  const receipt = state.invocations[0]!;
  await expect(f.store.commitApplication({kind:"reserve_invocation", agentId:agent, missionId:before.id,
    invocationId:"unbound", agentRevision:receipt.agentRevision, missionRevision:before.revision,
    configuration:receipt.configuration, stage:"authoring", reservedTokens:1})).rejects.toMatchObject({code:"agents_mission_not_active"});
  await f.app.shutdown();
  const app = trackAgentApplication(createAgentApplication(f.dependencies));
  await app.recover();
  const beforeCalls = f.invoke.mock.calls.length;
  expect((await app.detail(agent)).recovery).toMatchObject({pausedChatBlock:null,requiresNewBudget:false});
  await app.send(agent, followUp);
  await app.whenIdle();
  await app.send(agent, followUp);
  await app.whenIdle();
  const detail = await app.detail(agent);
  expect(f.invoke).toHaveBeenCalledTimes(beforeCalls + 1);
  expect(f.run).toHaveBeenCalledOnce();
  expect(detail.replyingToMessageIds).toEqual([]);
  expect(detail.mission).toMatchObject({id:before.id, status:before.status, revision:before.revision, waitingReason:before.waitingReason,
    usage:{modelCalls:before.usage.modelCalls + 1, totalTokens:before.usage.totalTokens + 10}});
  expect(detail.messages.filter((m) => m.id === "reply:side-question")).toHaveLength(1);
  const call = f.invoke.mock.calls.at(-1)![0];
  expect(call.format).toBeUndefined();
  const messages = call.messages as ChatMessage[];
  expect(messages.filter((m) => m.role === "user" && m.content === followUp.text)).toHaveLength(1);
  const capsule = JSON.parse(messages[1]!.content);
  expect(capsule.mission).toMatchObject({acceptedMode:"conversation_only", status:"awaiting_user_decision", waitingReason:"Paused by the user."});
  expect(capsule.evidence[0].text).toContain("https://example.test/source");
  const ordinary = projectAgentContext({state, agentId:agent, missionId:before.id, instructions:"Inspect"});
  expect(JSON.parse(ordinary[1]!.content).mission).not.toHaveProperty("waitingReason");
}, 20_000);

test("a spent call allowance blocks the side reply and retains the original pause", async () => {
  // EA selection, assignment authoring and two ordinary-session calls.
  const f = await pausedTask(4);
  const before = await f.app.detail(agent);
  expect(before.recovery).toMatchObject({pausedChatBlock:expect.stringContaining("all of its model calls"), requiresNewBudget:false});
  const count = f.invoke.mock.calls.length;
  await f.app.send(agent, followUp);
  await f.app.whenIdle();
  const after = await f.app.detail(agent);
  expect(after.mission).toEqual(before.mission);
  expect(after.messages.at(-1)?.text).toBe(before.recovery.pausedChatBlock);
  expect(f.invoke).toHaveBeenCalledTimes(count);
  expect(f.run).toHaveBeenCalledOnce();
}, 20_000);

test("a side reply with unknown usage preserves the pause and reserves recovery for the user", async () => {
  const f = await pausedTask();
  const before = (await f.app.detail(agent)).mission!;
  f.invoke.mockResolvedValueOnce({text:"Provider output without usage",meta:{}});
  await f.app.send(agent, followUp);
  await f.app.whenIdle();
  const after = await f.app.detail(agent);
  expect(after.mission).toMatchObject({id:before.id,revision:before.revision,waitingReason:before.waitingReason,status:"awaiting_user_decision"});
  expect(after.recovery.requiresNewBudget).toBe(true);
  expect(after.messages.at(-1)?.text).toBe(after.recovery.pausedChatBlock);
  const count = f.invoke.mock.calls.length;
  await f.app.send(agent, {...followUp, messageId:"another"});
  await f.app.whenIdle();
  await expect(f.app.resolve(agent, {action:"continue",text:"Please continue."})).rejects.toMatchObject({code:"agents_unknown_resolution_requires_limits"});
  expect(f.invoke).toHaveBeenCalledTimes(count);
  expect(f.run).toHaveBeenCalledOnce();
}, 20_000);

test("explicit continuation waits for the local side reply and charges both to the same mission", async () => {
  const f = await pausedTask();
  const before = (await f.app.detail(agent)).mission!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.invoke.mockImplementationOnce(async () => {
    await pending;
    return {text:"The result is saved.",meta:{usage:{inputTokens:3,outputTokens:1,totalTokens:4}}};
  });
  await f.app.send(agent, followUp);
  let continuing;
  try {
    await vi.waitFor(async () => expect((await f.store.read()).invocations.at(-1)?.status).toBe("reserved"));
    const detail = await f.app.detail(agent);
    expect(detail.replyingToMessageIds).toEqual([followUp.messageId]);
    expect(detail.recovery).toMatchObject({requiresNewBudget:false,pausedChatBlock:null});
    const other = trackAgentApplication(createAgentApplication(f.dependencies));
    expect((await other.detail(agent)).recovery.requiresNewBudget).toBe(true);
    continuing = f.app.resolve(agent, {action:"continue",text:"Present the saved evidence."});
  } finally { release(); }
  await continuing;
  await f.app.whenIdle();
  const detail = await f.app.detail(agent);
  expect(detail.mission?.id).toBe(before.id);
  expect(detail.mission!.revision).toBeGreaterThan(before.revision);
  expect(detail.messages.some((m) => m.id === "reply:side-question" && m.text === "The result is saved.")).toBe(true);
  expect(f.run).toHaveBeenCalledOnce();
}, 20_000);
