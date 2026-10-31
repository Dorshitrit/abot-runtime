import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "../ports.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import { WebNotificationStore, notificationStorePath } from "../../web-ui/notifications/store.js";
import { NOTIFICATION_RETENTION_MS } from "../../web-ui/notifications/retention.js";

let directory: string, now: number;
const changed = vi.fn();
function environment(id: string) {
  return { services: { config: { paths: { runtimeDir: join(directory, id, "runtime"),
    sessionsDir: join(directory, id, "sessions") } } as RuntimeConfig } };
}
function createService() {
  return new WebNotificationService({ hasEnvironment: (id) => ["dev", "prod"].includes(id), environment,
    isViewing: () => false, changed, desktop: async () => ({ available: false }),
    deliver: async () => ({ status: "unavailable" }), now: () => now });
}
function store(id = "dev") {
  const path = notificationStorePath({ ...environment(id).services.config.paths, environmentId: id });
  return { store: new WebNotificationStore(path, id, { now: () => now }), path };
}
function run(phase: string, status: string, runId = "run-1", environment = "dev") {
  return { type: "event", name: `automation.run.${phase}`, status, runId, automationId: "automation-1", environment };
}
beforeEach(async () => {
  const artifacts = join(process.cwd(), ".codex/artifacts/notification-source-read-20261030-d42f");
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(join(artifacts, "source-read-"));
  now = Date.now(); changed.mockClear();
  for (const id of ["dev", "prod"]) {
    const path = environment(id).services.config.paths.sessionsDir;
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "conversation.json"), JSON.stringify({ id: "conversation" }));
  }
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("viewing an active report covers its start, never a future finish or another run/environment", async () => {
  const service = createService();
  await service.markAutomationReportRead("dev", { runId: "run-1", phase: "started" });
  for (const event of [run("started", "running"), run("finished", "succeeded"),
    run("started", "running", "run-2"), run("started", "running", "run-1", "prod")]) service.observe(event);
  await service.flush();
  const page = await service.list("dev");
  expect(page.unreadCount).toBe(2);
  expect(page.items.find((item) => item.title === "Automation completed")?.readAt).toBeNull();
  expect((await service.list("prod")).unreadCount).toBe(1);
  expect(changed).toHaveBeenCalledWith("dev");
  await service.stop();
});

test.each(["succeeded", "completed_with_skips", "failed", "cancelled", "interrupted", "missed"])(
  "a terminal %s report covers late start and finish after restart, with manual unread preserved", async (status) => {
    const service = createService();
    await service.markAutomationReportRead("dev", { runId: "run-1", phase: "finished" });
    await service.stop();
    const restarted = createService();
    const events = [run("started", "running"), run("finished", status)];
    for (const event of events) restarted.observe(event);
    await restarted.flush();
    const page = await restarted.list("dev");
    expect(page.items).toHaveLength(2); expect(page.unreadCount).toBe(0);
    await restarted.markRead("dev", { ids: [page.items[0].id], read: false });
    for (const event of events) restarted.observe(event);
    await restarted.flush();
    expect((await restarted.list("dev")).unreadCount).toBe(1);
    await restarted.markAutomationReportRead("dev", { runId: "run-1", phase: "finished" });
    expect((await restarted.list("dev")).unreadCount).toBe(0);
    await restarted.stop();
  });

test("accepted decision receipts cover delayed approval notifications without changing session history", async () => {
  const service = createService();
  const path = join(environment("dev").services.config.paths.sessionsDir, "conversation.json");
  const before = await readFile(path, "utf8");
  service.observeApprovalDecision({ environmentId: "dev", requestId: "request-1", approvalId: "approval-1" });
  await service.flush(); await service.stop();
  const restarted = createService();
  const event = { type: "event", name: "tool.approval.required", environment: "dev", sessionId: "conversation",
    requestId: "request-1", approvalId: "approval-1" };
  restarted.observe(event);
  restarted.observe({ ...event, approvalId: "approval-2" });
  restarted.observe({ ...event, requestId: "request-2" });
  restarted.observe({ ...event, environment: "prod" });
  await restarted.flush();
  expect((await restarted.list("dev")).unreadCount).toBe(2);
  expect((await restarted.list("prod")).unreadCount).toBe(1);
  expect(await readFile(path, "utf8")).toBe(before);
  await restarted.stop();
});

test("source receipts are private, bounded, expire, and old notification stores remain readable", async () => {
  const { store: storage, path } = store();
  await storage.markSourceRead(Array.from({ length: 1000 }, (_, index) => `read-${index}`));
  now += 1;
  await storage.markSourceRead(["newest"]);
  const state = JSON.parse(await readFile(path, "utf8"));
  expect(state.sourceReads).toHaveLength(1000);
  expect(state.sourceReads[0].id).toBe("newest");
  expect(await storage.list()).not.toHaveProperty("sourceReads");
  now += NOTIFICATION_RETENTION_MS;
  await storage.list();
  expect(JSON.parse(await readFile(path, "utf8")).sourceReads).toEqual([]);
  delete state.sourceReads;
  await writeFile(path, JSON.stringify(state));
  const item = projectNotificationEvent(run("started", "running"), now)!;
  await storage.upsert(item);
  expect((await storage.list()).unreadCount).toBe(1);
});
