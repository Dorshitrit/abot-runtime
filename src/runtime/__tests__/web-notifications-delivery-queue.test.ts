import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "../ports.js";
import type { NotificationDelivery } from "../../web-ui/notifications/contracts.js";
import {
  WebNotificationService,
  type NotificationServiceOptions,
} from "../../web-ui/notifications/service.js";

const artifacts = join(
  process.cwd(),
  ".codex/artifacts/notification-review-fixes-20260927",
);
let directory: string;

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(join(artifacts, "delivery-queue-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function createService(deliver: NotificationServiceOptions["deliver"]) {
  return new WebNotificationService({
    hasEnvironment: (id) => ["dev", "prod"].includes(id),
    environment: (id) => ({
      services: {
        config: {
          paths: {
            runtimeDir: join(directory, id, "runtime"),
            sessionsDir: join(directory, id, "sessions"),
          },
        } as RuntimeConfig,
      },
    }),
    isViewing: () => false,
    changed: () => undefined,
    desktop: async () => ({ available: true }),
    deliver,
  });
}

function observeBurst(service: WebNotificationService, count: number): void {
  for (let index = 0; index < count; index++) {
    service.observe({
      type: "completed",
      requestId: `request-${index}`,
      environment: index % 2 === 0 ? "dev" : "prod",
      sessionId: "session-1",
      output: "The requested changes are ready.",
    });
  }
}

async function allItems(service: WebNotificationService) {
  const pages = await Promise.all([service.list("dev"), service.list("prod")]);
  return pages.flatMap((page) => page.items);
}

test("a mixed-environment burst records every item before waiting for native capacity", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const deliver = vi.fn(async (): Promise<NotificationDelivery> => {
    active++;
    peak = Math.max(peak, active);
    if (active > 4) {
      active--;
      return { status: "failed", error: "The host companion is busy." };
    }
    await gate;
    active--;
    return { status: "submitted" };
  });
  const service = createService(deliver);
  observeBurst(service, 9);
  await vi.waitFor(async () => expect(await allItems(service)).toHaveLength(9));
  let flushed = false;
  const flushing = service.flush().then(() => {
    flushed = true;
  });
  try {
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      (await allItems(service)).every(
        (item) => item.delivery.status === "pending",
      ),
    ).toBe(true);
    expect(flushed).toBe(false);
  } finally {
    release();
    await flushing;
  }
  expect(peak).toBe(1);
  expect(deliver).toHaveBeenCalledTimes(9);
  expect(
    (await allItems(service)).every(
      (item) => item.delivery.status === "submitted",
    ),
  ).toBe(true);
});

test("an uncertain or failed delivery does not prevent later queued notifications", async () => {
  const deliver = vi
    .fn<NotificationServiceOptions["deliver"]>()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce({ status: "failed", error: "permission denied" })
    .mockResolvedValue({ status: "submitted" });
  const service = createService(deliver);
  observeBurst(service, 3);
  await service.flush();
  const states = Object.fromEntries(
    (await allItems(service)).map((item) => [
      item.requestId,
      item.delivery.status,
    ]),
  );
  expect(states).toEqual({
    "request-0": "unknown",
    "request-1": "failed",
    "request-2": "submitted",
  });
  expect(deliver).toHaveBeenCalledTimes(3);
});

test("stopping cancels the active delivery and retains unsent queued history without dispatching it", async () => {
  const deliver = vi.fn<NotificationServiceOptions["deliver"]>(
    (_item, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "unknown" }), {
          once: true,
        });
      }),
  );
  const service = createService(deliver);
  observeBurst(service, 6);
  await vi.waitFor(async () => expect(await allItems(service)).toHaveLength(6));
  await service.stop();
  expect(deliver).toHaveBeenCalledTimes(1);
  const items = await allItems(service);
  expect(
    items.filter((item) => item.delivery.status === "unknown"),
  ).toHaveLength(1);
  expect(
    items.filter((item) => item.delivery.status === "unavailable"),
  ).toHaveLength(5);
  observeBurst(service, 7);
  await service.flush();
  expect(await allItems(service)).toHaveLength(6);
  const restarted = createService(deliver);
  observeBurst(restarted, 6);
  await restarted.flush();
  expect(deliver).toHaveBeenCalledTimes(1);
});

test("stopping before recording finishes persists accepted events without starting any delivery", async () => {
  const deliver = vi
    .fn<NotificationServiceOptions["deliver"]>()
    .mockResolvedValue({ status: "submitted" });
  const service = createService(deliver);
  observeBurst(service, 6);
  await service.stop();
  expect(deliver).not.toHaveBeenCalled();
  const items = await allItems(service);
  expect(items).toHaveLength(6);
  expect(items.every((item) => item.delivery.status === "unavailable")).toBe(
    true,
  );
});
