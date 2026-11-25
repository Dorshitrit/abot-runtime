import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import type { AgentApplicationDependencies, AgentApplicationService } from "../agents/application-contracts.js";
import type { AgentActionPlan } from "../agents/workspace-records.js";
import { createAgentApplication } from "../agents/application-service.js";
import { projectAgentContext } from "../agents/context-projection.js";
import { returnedWorkDecision, applicationPlan, agentApplicationFixture, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures);
const policies = ["execution-agent-v1", "supervisor-worker-v1"] as const;
const requestText = "Pass this exact backlog item to the list agent.";
const replyText = "The requested backlog item is now in the list.";
const partialReplyText = "The item is present; its requested date still needs checking.";
const initialAssignment = "Add the exact requested backlog item.";
const followUpAssignment = "Check the missing date on the existing backlog item.";
type ReturnedDelegation = {
  kind: "agent_delegation_result_v1"; missionId: string; missionRevision: number; exchangeId: string;
  recipientAgentId: string; assignment: string; outcome: string; text: string;
  omittedAssignmentCharacters: number; omittedReplyCharacters: number;
  addsUserIntent: false; grantsPermissions: false;
};
type CapturedCall = { agentId: string; missionId: string; stage: string; messages: ChatMessage[]; plan?: AgentActionPlan };
function returnedMessages(messages: readonly ChatMessage[]) {
  return messages.flatMap((message, index) => {
    if (message.role !== "system") return [];
    try {
      const value = JSON.parse(message.content);
      return value.kind === "agent_delegation_result_v1" ? [{ message, index, value: value as ReturnedDelegation }] : [];
    } catch { return []; }
  });
}
async function fixture(policy: typeof policies[number], options: { followUp?: boolean; childWork?: boolean } = {}) {
  const f = await agentApplicationFixture({ policy });
  const limits = { ...agentMissionLimits(), maxModelCalls: 80, maxTotalTokens: 100_000, maxClarificationRounds: 6 };
  const definition = (await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({ kind: "update_definition", agentId: "agent-a", definition: { ...definition, defaultLimits: limits } });
  await f.store.commitApplication({ kind: "register_agent", agentId: "abot", definition: { ...definition, name: "ABot", defaultLimits: limits } });
  const calls: CapturedCall[] = [];
  let app!: AgentApplicationService;
  const coordinate = vi.fn<NonNullable<AgentApplicationDependencies["coordinate"]>>(async (request) => {
    await app.receive("agent-a", { messageId: `peer:${request.correlationId}`, text: request.assignment, intent: "task", limits: request.limits },
      { agentId: request.senderAgentId, missionId: request.missionId, correlationId: request.correlationId });
    await app.whenIdle("agent-a");
    const child = await app.detail("agent-a");
    const mission = child.mission!;
    return { outcome: "completed", text: child.messages.filter((message) => message.missionId === mission.id && message.role === "assistant").at(-1)!.text,
      usage: { modelCalls: mission.usage.modelCalls, totalTokens: mission.usage.totalTokens, attempts: mission.usage.attempts, clarificationRounds: mission.usage.clarificationRounds } };
  });
  app = trackAgentApplication(createAgentApplication({ ...f.dependencies, coordinate,
    peers: async () => [{ id: "agent-a", name: "List", purpose: "Maintain the assigned list", modelProfileId: "fixture-super", status: "idle" }] }));
  f.invoke.mockImplementation(async (input) => {
    const state = await f.store.read();
    const record = state.invocations.find((entry) => entry.id === input.debugRequestId)!;
    const messages = input.messages as ChatMessage[];
    const capsule = JSON.parse(messages[1]!.content);
    const returned = returnedMessages(messages)[0]?.value;
    const call: CapturedCall = { agentId: record.agentId, missionId: record.missionId, stage: record.stage, messages };
    calls.push(call);
    let text = "Assess the established result against the current request.";
    if (input.format) {
      let plan: AgentActionPlan | ReturnType<typeof returnedWorkDecision>;
      if (record.agentId === "agent-a") {
        const attempt = state.attempts.find((entry) => entry.missionId === record.missionId);
        plan = applicationPlan("answer_user");
        if (options.childWork) {
          plan = applicationPlan("start_session");
          if (attempt) plan = returnedWorkDecision();
        }
      } else if (capsule.mission.objective !== requestText) {
        plan = applicationPlan("answer_user");
      } else if (returned && returned.text !== partialReplyText) {
        plan = applicationPlan("complete", { evidenceIds: [returned.exchangeId], metCriteriaIds: capsule.mission.criteria.map((criterion: { id: string }) => criterion.id) });
      } else {
        plan = applicationPlan("delegate_agent", { recipientAgentId: "agent-a" });
      }
      if ("sessionId" in plan) call.plan = plan;
      text = JSON.stringify({ decision: plan });
    } else if (record.stage === "authoring") {
      if (record.agentId === "agent-a") {
        text = replyText;
        if (options.followUp && capsule.mission.objective === initialAssignment) text = partialReplyText;
        if (capsule.acceptedPlan?.action === "start_session") text = "Verify the assigned backlog item.";
      } else {
        text = "The list agent confirmed the requested item.";
        if (capsule.acceptedPlan?.action === "delegate_agent") {
          text = initialAssignment;
          if (returned?.text === partialReplyText) text = followUpAssignment;
        }
      }
    }
    return { text, meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
  });
  async function run() {
    await app.send("abot", { messageId: "request", text: requestText, intent: "task" });
    await app.whenIdle("abot");
    return app.detail("abot");
  }
  return { ...f, app, calls, coordinate, ordinaryRun: f.run, run };
}

function expectContinuation(call: CapturedCall, exchange: { id: string; assignment: string; output: string | null; recipientAgentId: string }) {
  const results = returnedMessages(call.messages);
  expect(results).toHaveLength(1);
  const result = results[0]!;
  expect(result.message.role).toBe("system");
  expect(isInvocationContextMessage(result.message)).toBe(true);
  expect(result.value).toMatchObject({ missionId: call.missionId, missionRevision: 1, exchangeId: exchange.id,
    recipientAgentId: exchange.recipientAgentId, assignment: exchange.assignment, outcome: "completed", text: exchange.output,
    omittedAssignmentCharacters: 0, omittedReplyCharacters: 0, addsUserIntent: false, grantsPermissions: false });
  const activeRequests = call.messages.filter((message) => message.role === "user" && message.content === requestText);
  expect(activeRequests).toHaveLength(1);
  expect(result.index).toBeGreaterThan(call.messages.indexOf(activeRequests[0]!));
  const capsule = JSON.parse(call.messages[1]!.content);
  expect(capsule.peerReplies.some((entry: { id: string }) => entry.id === exchange.id)).toBe(false);
  expect(call.messages.filter((message) => message.content.includes(exchange.output!))).toHaveLength(1);
}

test.each(policies)("%s resumes the accepted request from the returned peer evidence and completes once", async (policy) => {
  const f = await fixture(policy); const detail = await f.run();
  expect(detail.mission?.status).toBe("completed");
  expect(f.coordinate).toHaveBeenCalledOnce();
  expect(detail.mailbox).toHaveLength(1);
  expect(detail.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  const exchange = detail.mailbox[0]!;
  const resumed = f.calls.filter((call) => call.agentId === "abot" && returnedMessages(call.messages).length);
  expect(resumed.map((call) => call.stage)).toEqual(policy === "supervisor-worker-v1" ? ["assessment", "selection", "authoring"] : ["assessment_and_selection", "authoring"]);
  for (const call of resumed) expectContinuation(call, exchange);
  expect(resumed.find((call) => call.plan)?.plan).toMatchObject({ action: "complete", evidenceIds: [exchange.id], metCriteriaIds: ["request"] });
  for (const call of f.calls.filter((entry) => entry.agentId === "agent-a")) expect(returnedMessages(call.messages)).toEqual([]);
}, 20_000);

test.each(policies)("%s can request genuine additional work after a partial peer answer with the existing empty-evidence contract", async (policy) => {
  const f = await fixture(policy, { followUp: true }); const detail = await f.run();
  expect(detail.mission?.status).toBe("completed");
  expect(f.coordinate).toHaveBeenCalledTimes(2);
  expect(detail.mailbox).toHaveLength(2);
  expect(detail.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  const followUp = f.calls.find((call) => call.plan?.action === "delegate_agent" && returnedMessages(call.messages).length)!;
  expect(followUp.plan?.evidenceIds).toEqual([]);
  expectContinuation(followUp, detail.mailbox[0]!);
  const lastChoice = f.calls.filter((call) => call.agentId === "abot" && call.plan).at(-1)!;
  expectContinuation(lastChoice, detail.mailbox[1]!);
  expect(JSON.parse(lastChoice.messages[1]!.content).peerReplies).toContainEqual(expect.objectContaining({ id: detail.mailbox[0]!.id, text: detail.mailbox[0]!.output }));
  expect(f.coordinate.mock.calls[1]![0].assignment).not.toBe(f.coordinate.mock.calls[0]![0].assignment);
  expect(detail.responsibility.every((trace) => trace.accepted)).toBe(true);
}, 20_000);

test("the returned parent evidence stays outside child work assignments, ordinary capabilities and a new mission", async () => {
  const f = await fixture("execution-agent-v1", { childWork: true }); const detail = await f.run();
  const originalMission = detail.mission!.id;
  expect(detail.mission?.status).toBe("completed");
  const state = await f.store.read();
  expect(f.ordinaryRun).toHaveBeenCalledOnce();
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0]!.agentId).toBe("agent-a");
  expect(state.attempts[0]!.request.assignment.startsWith("Verify the assigned backlog item.\n\n")).toBe(true);
  expect(JSON.stringify(state.attempts[0]!.request)).not.toContain("agent_delegation_result_v1");
  const childCalls = f.calls.filter((call) => call.agentId === "agent-a");
  expect(childCalls.length).toBeGreaterThan(0);
  expect(childCalls.every((call) => returnedMessages(call.messages).length === 0)).toBe(true);
  await f.app.send("abot", { messageId: "unrelated", text: "Explain an unrelated topic.", intent: "task" });
  await f.app.whenIdle("abot");
  const current = await f.app.detail("abot");
  expect(current.mission!.id).not.toBe(originalMission);
  expect(current.mission!.status).toBe("completed");
  for (const call of f.calls.filter((entry) => entry.agentId === "abot" && entry.missionId === current.mission!.id)) {
    expect(returnedMessages(call.messages)).toEqual([]);
    expect(call.messages.some((message) => message.content.includes(detail.mailbox[0]!.assignment))).toBe(false);
  }
  expect(f.coordinate).toHaveBeenCalledOnce();
}, 20_000);

test("returned evidence is bounded with declared omissions and rejects a stale mission or foreign exchange", async () => {
  const f = await fixture("execution-agent-v1"); const detail = await f.run();
  const state = await f.store.read(), mission = detail.mission!, exchange = detail.mailbox[0]!;
  // Model calls saw revision 1. The completed mission has advanced since that decision.
  const activeState = { ...state, missions: state.missions.map((entry) => entry.id === mission.id ? { ...entry, revision: 1, status: "active" as const } : entry) };
  const input = { state: activeState, agentId: "abot", missionId: mission.id, instructions: "Inspect the result", returnedExchangeId: exchange.id, evidenceCharacters: 12 };
  const projected = projectAgentContext(input);
  const result = returnedMessages(projected)[0]!;
  expect(result.value.assignment).toBe(exchange.assignment.slice(0, 12));
  expect(result.value.text).toBe(exchange.output!.slice(0, 12));
  expect(result.value.omittedAssignmentCharacters).toBe(exchange.assignment.length - 12);
  expect(result.value.omittedReplyCharacters).toBe(exchange.output!.length - 12);
  expect(isInvocationContextMessage(result.message)).toBe(true);
  expect(returnedMessages(projectAgentContext({ ...input, state }))).toEqual([]);
  expect(returnedMessages(projectAgentContext({ ...input, returnedExchangeId: "another-exchange" }))).toEqual([]);
  const foreign = { ...activeState, mailbox: activeState.mailbox.map((entry) => ({ ...entry, agentId: "agent-a" })) };
  expect(returnedMessages(projectAgentContext({ ...input, state: foreign }))).toEqual([]);
}, 20_000);


test.each(policies)("%s retains an unmeasured peer outcome for a user decision without claiming a verified handoff", async (policy) => {
  const f = await fixture(policy);
  f.coordinate.mockImplementationOnce(async () => ({ outcome: "completed", text: "An unverified completion claim.", usage: null }));
  const detail = await f.run();
  expect(detail.mission?.status).toBe("awaiting_user_decision");
  expect(detail.recovery.requiresNewBudget).toBe(true);
  expect(detail.mailbox).toEqual([expect.objectContaining({ status: "unknown", usage: null, output: "An unverified completion claim." })]);
  expect(f.coordinate).toHaveBeenCalledOnce();
  expect(detail.responsibility.some((trace) => trace.accepted && trace.plan.action === "complete")).toBe(false);
  expect(detail.messages.filter((message) => message.role === "assistant")).toEqual([]);
  expect(f.calls.every((call) => returnedMessages(call.messages).length === 0)).toBe(true);
  const state = await f.store.read();
  const unknownState = { ...state, missions: state.missions.map((mission) => mission.id === detail.mission!.id
    ? { ...mission, revision: detail.mailbox[0]!.missionRevision } : mission) };
  const projected = projectAgentContext({ state: unknownState, agentId: "abot", missionId: detail.mission!.id,
    instructions: "Inspect an unknown outcome", returnedExchangeId: detail.mailbox[0]!.id });
  expect(returnedMessages(projected)).toEqual([]);
}, 20_000);
