import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebNotificationStore } from "../notifications/store.js";
import { isWebNotification } from "../notifications/storage-schema.js";
import { projectAgentNotifications, type AgentNotificationCursor } from "../../runtime/agents/notification-attention.js";
import { delegatedApprovalFixture } from "../../runtime/__tests__/support/agents-approval-attention-fixture.js";
import { createAgentAttentionObserver } from "./agent-attention-notifications.js";
import type { AgentNotificationInbox } from "./agent-chat-notifications.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-approval-notices-")); directories.push(directory);
  const { state, wait, started } = delegatedApprovalFixture();
  const path = join(directory, "notifications.json");
  const makeStore = () => new WebNotificationStore(path, "dev", { now: () => started + 100 });
  let store = makeStore(), waits = [wait()];
  const created: string[] = [];
  const inbox: AgentNotificationInbox = {
    async recordAgentReply(item) { expect(isWebNotification(item, "dev")).toBe(true); if ((await store.upsert(item)).created) created.push(item.id); },
    unreadAgentReplies: async () => store.getUnreadAgentReplies(),
    forgetAgentReplies: async (_environment, agentId) => store.forgetAgentReplies(agentId),
    readAgentReplies: async (_environment, ids) => store.markSourceRead(ids),
  };
  const read = async (cursor: AgentNotificationCursor, since: number) => projectAgentNotifications(state, cursor, since, waits);
  return { state, started, wait, read, inbox, created, reopen() { store = makeStore(); }, waits(value: typeof waits) { waits = value; } };
}

test("each delegated approval round is durable once, replay-safe and targets its actual agent", async () => {
  const f = await fixture();
  const observe = createAgentAttentionObserver("dev", f.inbox, f.started);
  await observe(f.read); await observe(f.read);
  const first = (await f.inbox.unreadAgentReplies("dev"))[0]!;
  expect(first).toMatchObject({ kind: "approval", title: "child needs your approval", agentSource: { agentId: "child", missionId: "mission-child" } });
  expect(first.sourceUrl).toBe("/agents?environment=dev&agent=child");
  expect(f.created).toHaveLength(1);
  f.reopen(); await createAgentAttentionObserver("dev", f.inbox)(f.read);
  expect(f.created).toHaveLength(1);
  f.waits([f.wait("child", "wait-2")]); await observe(f.read);
  const second = await f.inbox.unreadAgentReplies("dev");
  expect(second).toHaveLength(1); expect(second[0]!.id).not.toBe(first.id);
  expect(f.created).toHaveLength(2);
  f.waits([]); await observe(f.read);
  expect(await f.inbox.unreadAgentReplies("dev")).toEqual([]);
});

test("failed persistence leaves cursor unadvanced and later retry retains that exact approval", async () => {
  const f = await fixture();
  const record = vi.spyOn(f.inbox, "recordAgentReply").mockRejectedValueOnce(new Error("disk unavailable"));
  const observe = createAgentAttentionObserver("dev", f.inbox);
  await expect(observe(f.read)).rejects.toThrow("disk unavailable");
  await observe(f.read);
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls[0]![0].id).toBe(record.mock.calls[1]![0].id);
  expect(await f.inbox.unreadAgentReplies("dev")).toHaveLength(1);
});

test("completed nonapproval replies stay owned by the existing reply observer", async () => {
  const f = await fixture(); f.waits([]);
  const state = { ...f.state, messages: [...f.state.messages, { id: "reply", agentId: "parent", missionId: "mission-parent", role: "assistant" as const, purpose: "reply" as const,
    source: null, text: "A public reply", createdAt: new Date(f.started + 30).toISOString() }] };
  await createAgentAttentionObserver("dev", f.inbox)(async (cursor, since) => projectAgentNotifications(state, cursor, since));
  expect(f.created).toEqual([]);
});

test("terminal budget attention reaches Web as a system notification without inventing a model reply", async () => {
  const f = await fixture(); f.waits([]);
  const createdAt = f.started + 50;
  const entry = { eventId: "a".repeat(64), targetAgentId: "child", agentName: "Research", missionId: "mission-child",
    reason: "attention" as const, attentionKind: "budget" as const, output: "", createdAt, expiresAt: createdAt + 1000 };
  await createAgentAttentionObserver("dev", f.inbox)(async cursor => ({ cursor, entries: [entry] }));
  expect(await f.inbox.unreadAgentReplies("dev")).toEqual([expect.objectContaining({ kind: "failure", title: "Research reached its task budget",
    body: "The task stopped at its configured limit. Open the agent to review the task and any saved work.",
    agentSource: { agentId: "child", missionId: "mission-child", messageId: "attention:" + entry.eventId } })]);
});
