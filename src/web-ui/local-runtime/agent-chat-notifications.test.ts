import { afterEach, expect, test, vi } from "vitest";
import { agentApplicationFixture, applicationPlan, returnedWorkDecision, completedAgentWork, disposeAgentApplicationFixtures } from "../../runtime/__tests__/support/agents-application-fixture.js";
import { WebNotificationService } from "../notifications/service.js";
import { NotificationPresence } from "../notifications/presence.js";
import { isWebNotification } from "../notifications/storage-schema.js";
import { agentReplyId, createAgentReplyObserver } from "./agent-chat-notifications.js";
import { projectAgentAttention, latestAgentAttentionId, attentionMessageIdsThrough, type AgentAttentionCursor } from "../../runtime/agents/attention.js";
import type { AgentApplicationDetail } from "../../runtime/agents/application-contracts.js";
import type { AgentState } from "../../runtime/agents/agent-records.js";

function projection(read: () => Promise<AgentState>) {
  return async (cursors: readonly AgentAttentionCursor[], since: number) => projectAgentAttention(await read(), cursors, since);
}
function replyIdsThrough(environment: string, detail: AgentApplicationDetail, through: string) {
  return attentionMessageIdsThrough(detail, through).map(id => agentReplyId(environment, detail.agent.id, id));
}

afterEach(disposeAgentApplicationFixtures);

async function setup(choice: NonNullable<Parameters<typeof agentApplicationFixture>[0]>["choose"] = () => applicationPlan("answer_user")) {
  const f = await agentApplicationFixture({ choose: choice });
  const presence = new NotificationPresence();
  const delivery = vi.fn(async () => ({ status: "submitted" as const }));
  const makeService = () => new WebNotificationService({
    hasEnvironment: (id) => id === "dev", environment: () => ({ services: { config: f.dependencies.config } }),
    isViewing: () => false, isViewingAgent: (env, id) => presence.isViewingAgent(env, id),
    changed: () => {}, desktop: async () => ({ available: true }), deliver: delivery,
  });
  const service = makeService();
  const observe = createAgentReplyObserver("dev", service);
  async function tick() { await observe(projection(() => f.store.read())); await service.flush(); }
  async function send(id: string, text: string) {
    await f.app.send("agent-a", { messageId: id, text, intent: "auto" });
    await f.app.whenIdle("agent-a");
    return f.app.detail("agent-a");
  }
  return { ...f, service, presence, delivery, tick, send, makeService };
}

test("deleting one agent removes its notices, and a second agent continues to deliver through restart", async () => {
  const f = await setup();
  const { definition } = (await f.store.read()).agents[0]!;
  async function recordReply(agentId: string, messageId: string) {
    // The observer consumes committed replies. Exercise its disk/replay path independently of model execution.
    await f.store.commitApplication({ kind: "open_agent_turn", agentId, missionId: messageId, messageId, text: "Check",
      intent: "task", limits: definition.defaultLimits!, source: null });
    await f.store.commitApplication({ kind: "finish_agent_turn", agentId, missionId: messageId, status: "exhausted",
      reason: "Fixture allowance exhausted", messageId: `reply:${messageId}`, text: "Partial result" });
  }
  await recordReply("agent-a", "first");
  await f.tick();
  await f.store.commitApplication({ kind: "register_agent", agentId: "agent-b", definition });
  await recordReply("agent-b", "other-first");
  await f.tick();
  const stale = await f.store.read();
  await f.store.beginDeletion("agent-a", stale.revision);
  await f.service.forgetAgentReplies("dev", "agent-a");
  await createAgentReplyObserver("dev", f.service)(projection(async () => stale));
  await f.tick();
  await f.store.finishDeletion("agent-a");
  await recordReply("agent-b", "other-next");
  await f.tick();
  const unread = await f.service.unreadAgentReplies("dev");
  expect(unread.map(item => item.agentSource.agentId)).toEqual(["agent-b", "agent-b"]);
  expect(f.delivery).toHaveBeenCalledTimes(3);
  await f.service.stop();
  const restart = f.makeService();
  await createAgentReplyObserver("dev", restart)(projection(() => f.store.read()));
  expect((await restart.unreadAgentReplies("dev")).map(item => item.id)).toEqual(unread.map(item => item.id));
  await restart.stop();
});

test("the owner returns a bounded public preview and resumes attention cursors without exposing workspace records", async () => {
  const f = await setup();
  await f.send("greeting", "היי");
  const state = await f.store.read();
  const reply = state.messages.find(message => message.role === "assistant")!;
  const page = projectAgentAttention({ ...state, messages: state.messages.map(message => message === reply
    ? { ...message, text: "🌙".repeat(610) } : message) }, [], 0);
  expect(page.cursors).toEqual([{ agentId: "agent-a", messages: state.messages.length, traces: state.responsibility.length }]);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]!.text).toBe("🌙".repeat(600));
  expect(Object.keys(page.entries[0]!).sort()).toEqual(["agentId", "agentName", "createdAt", "kind", "messageId", "missionId", "recovery", "text"]);
  expect(projectAgentAttention(state, page.cursors, 0).entries).toEqual([]);
  expect(projectAgentAttention(state, [], Date.parse(reply.createdAt)).entries).toEqual([]);
});

test("a normal greeting produces a durable scoped unread reply outside the chat, once across restart", async () => {
  const f = await setup();
  const detail = await f.send("greeting", "היי");
  await f.tick(); await f.tick();
  const [item] = await f.service.unreadAgentReplies("dev");
  expect(item).toMatchObject({ kind: "reply", body: detail.messages.at(-1)?.text, sourceUrl: "/agents?environment=dev&agent=agent-a",
    agentSource: { messageId: latestAgentAttentionId(detail), agentId: "agent-a" } });
  expect(f.run).not.toHaveBeenCalled();
  expect(f.delivery).toHaveBeenCalledTimes(1);
  expect(isWebNotification({ ...item, sourceUrl: "/agents?environment=dev&agent=another" }, "dev")).toBe(false);
  expect(isWebNotification({ ...item, sessionId: "ordinary" }, "dev")).toBe(false);
  await f.service.stop();
  const restart = f.makeService();
  await createAgentReplyObserver("dev", restart)(projection(() => f.store.read()));
  await restart.flush();
  expect(await restart.unreadAgentReplies("dev")).toHaveLength(1);
  expect(f.delivery).toHaveBeenCalledTimes(1);
  const id = latestAgentAttentionId(detail)!;
  expect(() => replyIdsThrough("dev", detail, "another-message")).toThrow("agents_message_not_found");
  await restart.readAgentReplies("dev", replyIdsThrough("dev", detail, id));
  expect(await restart.unreadAgentReplies("dev")).toHaveLength(0);
  await restart.stop();
});

test("an early read before delivery covers only the rendered reply; agent and ordinary presence do not collide", async () => {
  const f = await setup();
  const first = await f.send("one", "Hi");
  const seen = latestAgentAttentionId(first)!;
  await f.service.readAgentReplies("dev", replyIdsThrough("dev", first, seen));
  await f.tick();
  expect(f.delivery).not.toHaveBeenCalled();
  expect(await f.service.unreadAgentReplies("dev")).toHaveLength(0);
  const client = {};
  f.presence.update(client, { active: true, environment: "dev", sessionId: "agent-a" });
  await f.send("two", "Another question"); await f.tick();
  expect(f.delivery).toHaveBeenCalledTimes(1);
  f.presence.update(client, { active: true, environment: "dev", agentId: "agent-a" });
  const third = await f.send("three", "And another"); await f.tick();
  expect(f.presence.isViewing("dev", "agent-a")).toBe(false);
  expect(f.delivery).toHaveBeenCalledTimes(1);
  const unread = await f.service.unreadAgentReplies("dev");
  expect(unread).toHaveLength(2);
  expect(unread.map((item) => item.id)).toContain(agentReplyId("dev", "agent-a", latestAgentAttentionId(third)!));
  await f.service.stop();
});

test("a rejected proposal creates one actionable notice with no work dispatch", async () => {
  const f = await setup(() => "{malformed");
  const detail = await f.send("work", "Work on the request");
  expect(detail.status).toBe("awaiting_user_decision");
  await f.tick();
  const [item] = await f.service.unreadAgentReplies("dev");
  expect(item).toMatchObject({ kind: "failure", agentSource: { messageId: latestAgentAttentionId(detail) } });
  expect(item?.body).toMatch(/next step/);
  expect(item?.body).not.toContain("agents_plan_invalid");
  expect(f.run).not.toHaveBeenCalled();
  await f.service.stop();
});

test("a terminal work outcome reaches the inbox and identifies exhaustion separately from success", async () => {
  for (const outcome of ["complete", "exhausted"] as const) {
    const f = await setup(state => state.attempts.length ? returnedWorkDecision() : applicationPlan("start_session"));
    const { definition } = (await f.store.read()).agents[0]!;
    if (outcome === "exhausted") {
      await f.store.commitApplication({ kind: "update_definition", agentId: "agent-a", definition: {
        ...definition, defaultLimits: { ...definition.defaultLimits!, maxModelCalls: 4 },
      } });
    }
    const detail = await f.send("assignment", "Do this task"); await f.tick();
    const [notice] = await f.service.unreadAgentReplies("dev");
    expect(detail.mission?.status).toBe(outcome === "complete" ? "completed" : "exhausted");
    expect(notice?.kind).toBe(outcome === "complete" ? "reply" : "failure");
    expect(notice?.title).toContain(outcome === "complete" ? "reported the result" : "stopped before finishing");
    expect(f.delivery).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(1);
    await f.service.stop();
  }
});

test("a malformed post-work choice delivers only the recorded reply, even when the observer sees the rejection first", async () => {
  const f = await setup(state => state.attempts.length ? "invalid response decision" : applicationPlan("start_session"));
  const commit = f.store.commitApplication.bind(f.store);
  let observedRejection = false;
  vi.spyOn(f.store, "commitApplication").mockImplementation(async command => {
    const state = await commit(command);
    if (command.kind === "reject_agent_plan") {
      observedRejection = true;
      await f.tick();
      expect(await f.service.unreadAgentReplies("dev")).toEqual([]);
    }
    return state;
  });
  try {
    const detail = await f.send("assignment", "Report the available product information.");
    expect(observedRejection).toBe(true);
    expect(detail.messages.at(-1)?.text).toBe(completedAgentWork.output);
    await f.tick();
    const notices = await f.service.unreadAgentReplies("dev");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toBe(completedAgentWork.output);
    expect(notices[0]?.title).not.toContain("needs your decision");
    expect(f.delivery).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  } finally {
    await f.service.stop();
  }
});
