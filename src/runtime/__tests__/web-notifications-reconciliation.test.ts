import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import type { NotificationDelivery } from "../../web-ui/notifications/contracts.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import type { NotificationStoreState } from "../../web-ui/notifications/storage-schema.js";
import {
  notificationStorePath,
  WebNotificationStore,
} from "../../web-ui/notifications/store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: vi.fn(fs.readFile),
    writeFile: vi.fn(fs.writeFile),
    rename: vi.fn(fs.rename),
  };
});

const roots: string[] = [];
const services: WebNotificationService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

const interruptedReceipt = {
  status: "unknown" as const,
  error:
    "ABot restarted before delivery was confirmed. This notification was not sent again.",
};

function reply(index: number, environment = "dev") {
  return {
    type: "completed",
    environment,
    sessionId: "chat",
    requestId: "request-" + index,
    output: "A retained reply " + index,
  };
}

function history(
  environmentId = "dev",
  withPending = true,
): NotificationStoreState {
  const statuses: NotificationDelivery["status"][] = [
    withPending ? "pending" : "submitted",
    "submitted",
    "disabled",
    "unavailable",
    "failed",
    "unknown",
  ];
  return {
    version: 1,
    environmentId,
    preferences: {
      desktopEnabled: true,
      kinds: { reply: true, failure: false, approval: true, proposal: false },
    },
    items: Array.from({ length: 601 }, (_, index) => ({
      ...projectNotificationEvent(reply(index, environmentId), 1_000 + index)!,
      readAt: index % 3 === 0 ? 3_000 : null,
      delivery: {
        status: statuses[index % statuses.length],
        error: "Retained receipt " + index,
      },
    })),
  };
}

async function fixture(state = history()) {
  const artifacts = resolve(
    ".codex/artifacts/notification-history-ci-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "reconciliation-"));
  roots.push(root);
  const paths = { runtimeDir: root, sessionsDir: join(root, "sessions") };
  const path = notificationStorePath({ ...paths, environmentId: "dev" });
  const otherPath = notificationStorePath({ ...paths, environmentId: "prod" });
  const otherState = JSON.stringify(history("prod"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state));
  await writeFile(otherPath, otherState);
  const deliver = vi.fn(async () => ({ status: "submitted" as const }));
  const service = new WebNotificationService({
    hasEnvironment: (id) => ["dev", "prod"].includes(id),
    environment: () => ({ services: { config: { paths } as RuntimeConfig } }),
    isViewing: () => false,
    changed: vi.fn(),
    desktop: async () => ({ available: true }),
    deliver,
  });
  services.push(service);
  vi.clearAllMocks();
  return {
    path,
    otherPath,
    otherState,
    service,
    deliver,
    store: new WebNotificationStore(path, "dev"),
  };
}

function historyIo(path: string) {
  return {
    reads: vi.mocked(readFile).mock.calls.filter(([file]) => file === path)
      .length,
    writes: vi
      .mocked(writeFile)
      .mock.calls.filter(([file]) => String(file).startsWith(path + "."))
      .length,
    replacements: vi
      .mocked(rename)
      .mock.calls.filter(([, target]) => target === path).length,
  };
}

test("opening mixed history reconciles every pending receipt with one atomic write and no native replay", async () => {
  const original = history();
  const f = await fixture(original);
  const page = await f.service.list("dev", { limit: 100 });
  // One recovery read and one read for the requested page, regardless of history size.
  expect(historyIo(f.path)).toEqual({ reads: 2, writes: 1, replacements: 1 });
  const expected = structuredClone(original);
  for (const item of expected.items) {
    if (item.delivery.status === "pending") item.delivery = interruptedReceipt;
  }
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(expected);
  expect(await readFile(f.otherPath, "utf8")).toBe(f.otherState);
  expect(page.items).toHaveLength(100);
  expect(page.unreadCount).toBe(400);
  expect(page.preferences).toEqual(original.preferences);
  expect(page.nextCursor).not.toBeNull();
  f.service.observe(reply(0));
  await f.service.flush();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(expected);
}, 20_000);

test("opening settled history preserves its bytes without a reconciliation write", async () => {
  const state = history("dev", false);
  const f = await fixture(state);
  await f.service.list("dev");
  expect(historyIo(f.path)).toEqual({ reads: 2, writes: 0, replacements: 0 });
  expect(await readFile(f.path, "utf8")).toBe(JSON.stringify(state));
  expect(f.deliver).not.toHaveBeenCalled();
});

test.each([true, false])(
  "store reconciliation reads once when pending history is %s",
  async (pending) => {
    const f = await fixture(history("dev", pending));
    await f.store.reconcilePendingDeliveries();
    expect(historyIo(f.path)).toEqual({
      reads: 1,
      writes: pending ? 1 : 0,
      replacements: pending ? 1 : 0,
    });
    vi.clearAllMocks();
    await f.store.reconcilePendingDeliveries();
    expect(historyIo(f.path)).toEqual({ reads: 1, writes: 0, replacements: 0 });
  },
);

test("reconciliation uses the shared transaction order and retains concurrent preference and read updates", async () => {
  const state = history();
  const f = await fixture(state);
  const other = new WebNotificationStore(f.path, "dev");
  const preferences = { ...state.preferences, desktopEnabled: false };
  const first = state.items[0].id;
  await Promise.all([
    other.setPreferences(preferences),
    f.store.reconcilePendingDeliveries(),
    other.markRead({ ids: [first], read: false }),
  ]);
  const saved = JSON.parse(
    await readFile(f.path, "utf8"),
  ) as NotificationStoreState;
  expect(saved.items).toHaveLength(state.items.length);
  expect(saved.preferences).toEqual(preferences);
  expect(saved.items[0]).toEqual({
    ...state.items[0],
    delivery: interruptedReceipt,
    readAt: null,
  });
  expect(saved.items.some((item) => item.delivery.status === "pending")).toBe(
    false,
  );
});
