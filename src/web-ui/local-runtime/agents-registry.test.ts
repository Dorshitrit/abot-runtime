import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentWebCleanup } from "../../runtime/agents/workspace-web-cleanup.js";
import { projectAgentAttention, type AgentAttentionCursor } from "../../runtime/agents/attention.js";
import { projectAgentNotifications, type AgentNotificationCursor, type AgentNotificationPage } from "../../runtime/agents/notification-attention.js";
import { delegatedApprovalFixture } from "../../runtime/__tests__/support/agents-approval-attention-fixture.js";
import { createEmptyAgentState } from "../../runtime/agents/agent-records.js";
import type { RuntimeEnvironment } from "./contracts.js";
import { WebAgentRegistry } from "./agents-registry.js";

const directories: string[] = [], registries: WebAgentRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stop();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(withNotifications = false) {
  const dir = await mkdtemp(join(tmpdir(), "abot-agent-projection-")); directories.push(dir);
  const projection = createAgentWebCleanup(dir);
  const state = createEmptyAgentState();
  const local = vi.fn();
  const listeners = new Set<(rev: number) => void>();
  const attention = vi.fn(async (cursors: readonly AgentAttentionCursor[], since: number) => projectAgentAttention(state, cursors, since));
  const notifications = vi.fn(async (cursor: AgentNotificationCursor, _since: number): Promise<AgentNotificationPage> => ({ cursor, entries: [] }));
  const agents = { local, projection: { ...projection, attention, ...(withNotifications && { notifications }), through: vi.fn() }, isBusy: vi.fn(async () => false) };
  const environment = { agents, subscribeAgentEvents: (fn: (rev: number) => void) => {
    listeners.add(fn); return () => listeners.delete(fn);
  } } as unknown as RuntimeEnvironment;
  const inbox = { recordAgentReply: vi.fn(), unreadAgentReplies: vi.fn(async () => []), forgetAgentReplies: vi.fn(), readAgentReplies: vi.fn() };
  const forgetSession = vi.fn(), forgetDrafts = vi.fn();
  const registry = new WebAgentRegistry(() => environment, inbox, forgetSession, forgetDrafts); registries.push(registry);
  return { agents, notifications, projection, listeners, registry, inbox, forgetSession, forgetDrafts, dir };
}
test("concurrent Web views share one subscription and closing Web detaches only the view", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.registry.get("dev"), f.registry.get("dev")]);
  expect(a).toBe(b);
  expect(a.local).toBe(f.agents.local);
  expect(Object.keys(a).sort()).toEqual(["detach", "isBusy", "local", "projection", "sync"]);
  expect(Object.keys(a.projection)).toEqual(["through"]);
  expect(f.listeners.size).toBe(1);
  f.agents.isBusy.mockResolvedValue(true);
  expect(await f.registry.isBusy()).toBe(true);
  await f.registry.stop();
  expect(f.listeners.size).toBe(0);
});
test("headless cleanup survives reopen and a failed draft cleanup is retried before acknowledgement", async () => {
  const f = await fixture();
  await f.projection.record("deleted", ["owned-a", "owned-b"]);
  f.forgetDrafts.mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(f.registry.get("dev")).rejects.toThrow("Disk unavailable");
  expect(f.listeners.size).toBe(0);
  expect(await createAgentWebCleanup(f.dir).pending()).toEqual([{ agentId: "deleted", sessionIds: ["owned-a", "owned-b"] }]);
  await f.registry.get("dev");
  expect(f.forgetSession).toHaveBeenCalledWith("dev", "owned-b");
  expect(f.inbox.forgetAgentReplies).toHaveBeenCalledWith("dev", "deleted");
  expect(f.forgetDrafts).toHaveBeenCalledTimes(2);
  expect(await f.projection.pending()).toEqual([]);
});
test("failure to read the retained workspace detaches the Web projection and preserves its owner's error", async () => {
  const f = await fixture();
  f.agents.projection.attention.mockRejectedValueOnce(new Error("Corrupt state"));
  await expect(f.registry.get("dev")).rejects.toThrow("Corrupt state");
  expect(f.listeners.size).toBe(0);
  await f.registry.get("dev");
  expect(f.listeners.size).toBe(1);
});

test("a later approval wait is published even when Agent revision is unchanged", async () => {
  const f = await fixture(true), data = delegatedApprovalFixture();
  let wait = data.wait("child", "first");
  f.notifications.mockImplementation(async (cursor, since) => projectAgentNotifications(data.state, cursor, since, [wait]));
  const entry = await f.registry.get("dev");
  expect(f.inbox.recordAgentReply).toHaveBeenCalledTimes(1);
  const first = f.inbox.recordAgentReply.mock.calls[0]![0];
  wait = data.wait("child", "second");
  for (const changed of f.listeners) changed(0);
  await entry.sync();
  expect(f.inbox.recordAgentReply).toHaveBeenCalledTimes(2);
  expect(f.inbox.recordAgentReply.mock.calls[1]![0]).toMatchObject({ kind: "approval", agentSource: { agentId: "child" } });
  expect(f.inbox.recordAgentReply.mock.calls[1]![0].id).not.toBe(first.id);
  for (const changed of f.listeners) changed(0);
  await entry.sync();
  expect(f.inbox.recordAgentReply).toHaveBeenCalledTimes(2);
});
