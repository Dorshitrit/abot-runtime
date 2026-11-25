import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createNotificationsController } from "../../web-ui/app/controllers/notifications-controller.js";
// @ts-expect-error Browser-only module.
import { createHomeErrorAttention } from "../../web-ui/app/components/notifications/home-error-attention.js";
// @ts-expect-error Browser-only module.
import { renderNotificationItem } from "../../web-ui/app/components/notifications/presentation.js";
// @ts-expect-error Browser-only module.
import { createStepTimeoutController } from "../../web-ui/app/controllers/step-timeout-controller.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { isLowValueActivityEvent } from "../../web-ui/app/lib/event-presentation.js";

const reference = { environment: "dev", sessionId: "old-session", requestId: "request", invocationId: "call" };
const issue = { id: "group", environmentId: "dev", severity: "error", channel: "in-app", kind: "failure",
  title: "Model response timed out", body: "Review the timeout for this profile.", createdAt: 1, readAt: null,
  sourceUrl: "/chat?environment=dev&session=old-session", delivery: { status: "disabled" },
  issue: { occurrenceCount: 2, firstOccurredAt: 1, lastOccurredAt: 5,
    outcomeCounts: { recovered: 0, failed: 2, interrupted: 0 }, action: { kind: "step-timeout", reference } } };
function fixture() {
  let environment = "dev";
  const page = { items: [issue], unreadCount: 4, unreadErrorCount: 3, readBoundary: 8 };
  const client = {
    supportsNotifications: () => true,
    listNotifications: vi.fn(async () => page),
    markNotificationsRead: vi.fn(async (_input: unknown, _environment: string): Promise<any> => ({})),
  };
  const render = vi.fn();
  const controller = createNotificationsController({ client, getEnvironmentId: () => environment, render });
  return { client, controller, render, page, switchEnvironment: () => { environment = "prod"; controller.environmentChanged(); } };
}
afterEach(() => vi.useRealTimers());

test("read sends the observed count and retains a concurrent occurrence even when refresh fails", async () => {
  const f = fixture(); await f.controller.setReady();
  f.client.markNotificationsRead.mockResolvedValue({ unreadCount: 4, unreadErrorCount: 3, readBoundary: 9,
    issueStates: [{ id: "group", occurrenceCount: 3, readAt: null }] });
  f.client.listNotifications.mockRejectedValueOnce(new Error("Offline"));
  await f.controller.markRead("group");
  expect(f.client.markNotificationsRead).toHaveBeenCalledWith({ ids: ["group"], read: true,
    observedIssues: [{ id: "group", occurrenceCount: 2 }] }, "dev");
  expect(f.controller.snapshot()).toMatchObject({ unreadErrorCount: 3, readBoundary: 9, error: "Offline",
    items: [{ readAt: null, issue: { occurrenceCount: 3 } }] });
  f.controller.dispose();
});

test("mark all uses the server boundary, read ACK clears Home despite a failed reload", async () => {
  const f = fixture(); await f.controller.setReady();
  f.client.markNotificationsRead.mockResolvedValue({ unreadCount: 0, unreadErrorCount: 0, readBoundary: 8,
    issueStates: [{ id: "group", occurrenceCount: 2, readAt: 10 }] });
  f.client.listNotifications.mockRejectedValueOnce(new Error("Offline"));
  await f.controller.markAllRead();
  expect(f.client.markNotificationsRead).toHaveBeenCalledWith({ all: true, read: true, issueReadBoundary: 8 }, "dev");
  expect(f.controller.snapshot()).toMatchObject({ unreadErrorCount: 0, items: [{ readAt: 10 }] });
  f.switchEnvironment();
  expect(f.controller.snapshot()).toMatchObject({ unreadErrorCount: 0, readBoundary: null, items: [] });
  f.controller.dispose();
});

test("an older read ACK cannot erase a recurrence already loaded by realtime when the next GET fails", async () => {
  const f = fixture(); await f.controller.setReady();
  let acknowledge!: (value: unknown) => void;
  f.client.markNotificationsRead.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
  const marking = f.controller.markRead("group");
  f.client.listNotifications.mockResolvedValueOnce({ ...f.page, readBoundary: 9,
    items: [{ ...issue, issue: { ...issue.issue, occurrenceCount: 3 } }] });
  await f.controller.refresh();
  f.client.listNotifications.mockRejectedValueOnce(new Error("Offline"));
  acknowledge({ unreadCount: 0, unreadErrorCount: 0, readBoundary: 8,
    issueStates: [{ id: "group", occurrenceCount: 2, readAt: 10 }] });
  await marking;
  expect(f.controller.snapshot()).toMatchObject({ unreadErrorCount: 3, readBoundary: 9,
    items: [{ readAt: null, issue: { occurrenceCount: 3 } }] });
  f.controller.dispose();
});

test("a current ACK carries coherent outcomes and the latest bound SPARK source when reload fails", async () => {
  const f = fixture(); await f.controller.setReady();
  const latest = { ...issue.issue, occurrenceCount: 3, lastOccurredAt: 20,
    outcomeCounts: { recovered: 1, failed: 2, interrupted: 0 } };
  f.client.markNotificationsRead.mockResolvedValue({ unreadCount: 4, unreadErrorCount: 3, readBoundary: 9,
    issueStates: [{ id: "group", occurrenceCount: 3, readAt: null, issue: latest,
      title: "A newer occurrence", body: "Recovered.", sourceUrl: "/home?environment=dev&spark=1",
      sessionId: "spark-companion", sessionKind: "spark", requestId: "latest" }] });
  f.client.listNotifications.mockRejectedValueOnce(new Error("Offline"));
  await f.controller.markRead("group");
  expect(f.controller.snapshot().items[0]).toMatchObject({ issue: latest, body: "Recovered.",
    sessionKind: "spark", sourceUrl: "/home?environment=dev&spark=1" });
  f.controller.dispose();
});

test("a 39-event burst makes one shared refresh and two renders, with no receipt-derived counting", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.controller.setReady(); f.render.mockClear();
  for (let i = 0; i < 39; i++) f.controller.handleRealtime({ type: "workspace_changed", environment: "dev", resources: ["notifications"] });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.client.listNotifications).toHaveBeenCalledTimes(2);
  expect(f.render).toHaveBeenCalledTimes(2);
  expect(f.controller.snapshot().unreadErrorCount).toBe(3);
  f.controller.dispose();
});

test("Home attention uses all stored unread groups, opens without marking read, and hides on scope loss", () => {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  const panel = document.createElement("section");
  panel.innerHTML = '<header class="home-workspace-header"></header>';
  const header = panel.querySelector("header")!;
  Object.assign(header, { after: (node: FakeElement) => panel.append(node) });
  const onOpen = vi.fn(); const home = createHomeErrorAttention({ homePanel: panel, onOpen });
  const region = panel.querySelector(".home-error-attention")!;
  const button = region.querySelector("button")!;
  home.render({ supported: true, unreadErrorCount: 3, items: [] });
  expect(region.hidden).toBe(false);
  expect(region.textContent).toContain("3 unread errors need your attention");
  button.dispatch("click"); expect(onOpen).toHaveBeenCalledOnce();
  home.render({ supported: true, unreadErrorCount: 0 }); expect(region.hidden).toBe(true);
  home.render({ supported: false, unreadErrorCount: 3 }); button.dispatch("click");
  expect(onOpen).toHaveBeenCalledOnce();
});

test("group row exposes error, occurrences, outcome and manual remedy without implying native delivery", () => {
  const html = renderNotificationItem(issue, false);
  expect(html).toContain(">Error</span>"); expect(html).toContain("×2");
  expect(html).toContain("2 failed"); expect(html).toContain("In-app only");
  expect(html).toContain("Review timeout"); expect(html).not.toContain("Desktop alerts off");
  expect(isLowValueActivityEvent({ type: "event", name: "model.issue.observed" })).toBe(true);
  expect(isLowValueActivityEvent({ type: "failed", name: "model.issue.observed" })).toBe(false);
});

test("explicit notification review reuses validated timeout save and idle restart for another session", async () => {
  const scope = { backend: "runtime", workspace: "notifications", environment: "dev", sessionId: "current" };
  const suggestion = { canIncrease: true, revision: "revision" };
  const client = { inspectStepTimeout: vi.fn(async () => ({ suggestion })), increaseStepTimeout: vi.fn(async () => {}),
    applyRuntimeConfiguration: vi.fn(async () => ({ activation: { status: "ready" } })) };
  const render = vi.fn(); const controller = createStepTimeoutController({ client, getScope: () => scope, render });
  await controller.review(reference);
  expect(client.inspectStepTimeout).toHaveBeenCalledWith(reference);
  expect(client.increaseStepTimeout).not.toHaveBeenCalled();
  await controller.increase();
  expect(client.increaseStepTimeout).toHaveBeenCalledWith(reference, "revision");
  expect(client.applyRuntimeConfiguration).toHaveBeenCalledWith("dev");
  await controller.review({ ...reference, environment: "prod" });
  expect(client.inspectStepTimeout).toHaveBeenCalledOnce();
});

test("navigation invalidates explicit timeout inspection and a pending save cannot be replaced", async () => {
  const scope = { backend: "runtime", workspace: "notifications", environment: "dev" };
  let release!: (value: any) => void;
  const client = { inspectStepTimeout: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    increaseStepTimeout: vi.fn(async () => {}), applyRuntimeConfiguration: vi.fn(async () => ({ activation: { status: "restart_required" } })) };
  const render = vi.fn(); const controller = createStepTimeoutController({ client, getScope: () => scope, render });
  const pending = controller.review(reference);
  scope.workspace = "home"; controller.syncScope(); scope.workspace = "notifications"; controller.syncScope();
  release({ suggestion: { canIncrease: true, revision: "revision" } }); await pending;
  expect(render).toHaveBeenLastCalledWith(null);
  const next = controller.review(reference); release({ suggestion: { canIncrease: true, revision: "revision" } }); await next;
  await controller.increase();
  await expect(controller.review({ ...reference, invocationId: "another" })).rejects.toThrow("pending timeout update");
  expect(client.inspectStepTimeout).toHaveBeenCalledTimes(2);
});
