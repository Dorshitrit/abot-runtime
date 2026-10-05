import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as sessionStore from "../../sessions/session-store.js";
import { WebNotificationService, type NotificationServiceOptions } from "../../web-ui/notifications/service.js";
import type { RuntimeConfig } from "../ports.js";

const artifacts = join(process.cwd(), ".codex/artifacts/pr119-review-followup-20260929");
const automationOrigin = {
  kind: "automation_node_v1", automationId: "workflow", runId: "run",
  nodeId: "agent", attemptId: "attempt",
};
let directory: string;
let sessionsDir: string;
let service: WebNotificationService;
const deliver = vi.fn<NotificationServiceOptions["deliver"]>(async () => ({ status: "submitted" }));

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(join(artifacts, "notification-session-lifetime-"));
  sessionsDir = join(directory, "sessions");
  await mkdir(sessionsDir);
  deliver.mockClear();
  service = new WebNotificationService({
    hasEnvironment: (id) => id === "dev",
    environment: () => ({ services: { config: {
      paths: { runtimeDir: directory, sessionsDir },
    } as RuntimeConfig } }),
    isViewing: () => false,
    changed: () => undefined,
    desktop: async () => ({ available: true }),
    deliver,
  });
});

afterEach(async () => {
  await service.stop();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function completed(sessionId: string) {
  return { type: "completed", environment: "dev", sessionId,
    requestId: `request-${sessionId}`, output: "The requested result is ready." };
}

function runEvent(phase: "started" | "finished") {
  return { type: "event", name: `automation.run.${phase}`, environment: "dev",
    automationId: "workflow", runId: "run", title: "Daily report",
    status: phase === "started" ? "running" : "succeeded" };
}

async function persistSession(id: string, internal = false) {
  await writeFile(join(sessionsDir, `${id}.json`), JSON.stringify({
    id, ...(internal ? { automationOrigin } : {}),
  }));
}

test.each([false, true])(
  "queued completion skips a deleted conversation (internal automation: %s)",
  async (internal) => {
    await persistSession("blocker");
    await persistSession("deleted", internal);
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const loadSession = sessionStore.loadSessionFile;
    const load = vi.spyOn(sessionStore, "loadSessionFile").mockImplementation(async (path, id) => {
      if (id === "blocker") {
        await blocked;
      }
      return loadSession(path, id);
    });
    service.observe(completed("blocker"));
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledWith(sessionsDir, "blocker"));
      service.observe(runEvent("started"));
      service.observe(completed("deleted"));
      service.observe(runEvent("finished"));
      expect(load).not.toHaveBeenCalledWith(sessionsDir, "deleted");
      expect(await sessionStore.deleteSessionFile(sessionsDir, "deleted")).toBe(true);
    } finally {
      release();
      await service.flush();
    }
    const { items } = await service.list("dev");
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.kind === "reply").map((item) => item.sessionId))
      .toEqual(["blocker"]);
    expect(items.filter((item) => item.kind === "automation").every((item) =>
      item.sourceUrl === "/automations?environment=dev&automation=workflow&run=run"))
      .toBe(true);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls.every(([item]) => item.sessionId !== "deleted")).toBe(true);
  },
);

test("a missing completed session creates no reply history or desktop delivery", async () => {
  service.observe(completed("missing"));
  await service.flush();
  expect((await service.list("dev")).items).toEqual([]);
  expect(deliver).not.toHaveBeenCalled();
});

test("persisted origin remains authoritative and ordinary replies keep their valid source", async () => {
  await persistSession("internal", true);
  await persistSession("ordinary");
  service.observe({ ...completed("internal"), automationOrigin: null });
  service.observe({ ...completed("ordinary"), automationOrigin });
  await service.flush();
  const { items } = await service.list("dev");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "reply", sessionId: "ordinary",
    sourceUrl: "/chat?environment=dev&session=ordinary" });
  expect(deliver).toHaveBeenCalledOnce();
});

test("missing-session suppression leaves failure events unchanged", async () => {
  service.observe({ ...completed("missing"), type: "failed", error: "provider failed" });
  await service.flush();
  expect((await service.list("dev")).items.map((item) => item.kind)).toEqual(["failure"]);
  expect(deliver).toHaveBeenCalledOnce();
});
