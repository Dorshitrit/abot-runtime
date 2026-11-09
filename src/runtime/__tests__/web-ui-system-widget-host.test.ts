import { afterEach, expect, test, vi } from "vitest";
import { managementDialogFixture, managedSkill, managedSource } from "./support/system-management-dialog-fixture.js";
import { SPARK_HOME_WIDGET_CATALOG } from "../spark-home/widgets/catalog.js";
// @ts-expect-error Browser-only reusable owner.
import { createSystemWidgets } from "../../web-ui/app/components/system-widgets/host.js";
// @ts-expect-error Browser-only native cards.
import { SYSTEM_WIDGET_HEIGHTS } from "../../web-ui/app/components/system-widgets/cards.js";

const candidate = { id: "candidate-a", revision: 3, content: "A user-confirmable preference" };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture(widgetId: string, dashboardWidgets?: { mount: ReturnType<typeof vi.fn> }) {
  const f = managementDialogFixture(); f.manager.destroy();
  const nativeEvents = new Map<string, Set<(event: unknown) => void>>();
  Object.assign(f.documentRoot, { defaultView: {
    addEventListener(name: string, listener: (event: unknown) => void) {
      if (!nativeEvents.has(name)) nativeEvents.set(name, new Set()); nativeEvents.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: (event: unknown) => void) { nativeEvents.get(name)?.delete(listener); },
  } });
  const root = f.documentRoot.createElement("section");
  root.setAttribute("aria-label", "An ordinary dashboard section"); f.documentRoot.body.append(root);
  Object.assign(root, { removeEventListener(name: string, listener: (event: unknown) => void) {
    root.listeners.set(name, (root.listeners.get(name) || []).filter(value => value !== listener));
  } });
  let environment = "dev";
  let candidates = [candidate];
  const client = { ...f.client,
    listPassiveLearningCandidates: vi.fn(async () => ({ items: candidates })),
    loadPassiveLearning: vi.fn(async () => ({ status: { preferences: { activityPermissions: { learning: true, proactive: true } } } })),
    promoteLearningCandidate: vi.fn(async (_input: unknown) => { candidates = []; return { record: { id: "saved" } }; }),
    deleteLearningCandidate: vi.fn(async (_input: unknown) => { candidates = []; return { deleted: true }; }),
  };
  const host = createSystemWidgets({ client, getEnvironmentId: () => environment, isAvailable: () => true,
    documentRoot: f.documentRoot, dashboardWidgets });
  const height = vi.fn();
  const view = host.mount(root, widgetId, height);
  cleanup.push(() => { view.dispose(); host.destroy(); });
  const find = (selector: string) => root.querySelector(selector)!;
  const currentConfirmation = () => f.documentRoot.body.querySelectorAll(".confirmation-dialog").find(dialog => dialog.open);
  const confirm = (approved: boolean) => currentConfirmation()!
    .querySelector(approved ? "[data-confirmation-accept]" : "[data-confirmation-cancel]")!.dispatch("click");
  host.setActive(true);
  return { ...f, root, host, view, client, height, find, confirm, currentConfirmation, nativeEvents,
    setEnvironment(value: string) { environment = value; host.environmentChanged(); } };
}

test.each([
  { widget: "skills", selector: '[data-widget-action="skill"]', title: "Manage Skills", contents: managedSkill.content },
  { widget: "resources", selector: '[data-widget-action="resources"]', title: "Manage Resources", contents: managedSource.displayName },
])("a native $widget card mounted in an ordinary section opens the existing manager after a click", async row => {
  const f = fixture(row.widget);
  await vi.waitFor(() => expect(f.find(row.selector)).not.toBeNull());
  const manager = f.documentRoot.body.querySelector(".system-management-dialog")!;
  expect(manager.open).toBe(false);
  f.host.setActive(false); f.find(row.selector).dispatch("click");
  expect(manager.open).toBe(false);
  f.host.setActive(true);
  f.find(row.selector).dispatch("click");
  await vi.waitFor(() => expect(manager.open).toBe(true));
  expect(manager.querySelector("h2")!.textContent).toBe(row.title);
  if (row.widget === "skills") await vi.waitFor(() => expect(manager.querySelector("[data-skills-content]")!.value).toBe(row.contents));
  else await vi.waitFor(() => expect(manager.textContent).toContain(row.contents));
  expect(f.root.closest("iframe")).toBeNull();
  expect(f.height).toHaveBeenLastCalledWith(SYSTEM_WIDGET_HEIGHTS[row.widget]);
});

test.each(["promote", "delete"])("candidate %s requires the actual confirmation dialog before exact-binding mutation", async action => {
  const f = fixture("memory-candidates");
  const selector = `[data-candidate-action="${action}"]`;
  await vi.waitFor(() => expect(f.find(selector)).not.toBeNull());
  const method = action === "promote" ? f.client.promoteLearningCandidate : f.client.deleteLearningCandidate;
  f.find(selector).dispatch("click");
  expect(method).not.toHaveBeenCalled();
  expect(f.currentConfirmation()?.textContent).toContain(candidate.content);
  expect(await f.host.prepareLeave()).toBe(false);
  f.confirm(false); await vi.waitFor(() => expect(f.host.isBusy()).toBe(false));
  expect(method).not.toHaveBeenCalled();
  f.find(selector).dispatch("click"); expect(method).not.toHaveBeenCalled();
  f.confirm(true);
  await vi.waitFor(() => expect(method).toHaveBeenCalledExactlyOnceWith({ id: candidate.id, revision: candidate.revision, environmentId: "dev" }));
  await vi.waitFor(() => expect(f.find(selector)).toBeNull());
});

test.each(["environment", "unmount", "inactive"])("a pending candidate confirmation cannot mutate after %s invalidation", async kind => {
  const f = fixture("memory-candidates");
  await vi.waitFor(() => expect(f.find('[data-candidate-action="promote"]')).not.toBeNull());
  f.find('[data-candidate-action="promote"]').dispatch("click");
  expect(f.currentConfirmation()?.open).toBe(true);
  const originalConfirmation = f.currentConfirmation()!;
  const staleAccept = originalConfirmation.querySelector("[data-confirmation-accept]")!;
  if (kind === "environment") f.setEnvironment("prod");
  if (kind === "unmount") f.view.dispose();
  if (kind === "inactive") f.host.setActive(false);
  if (kind !== "inactive") expect(originalConfirmation.open).toBe(false);
  staleAccept.dispatch("click"); await Promise.resolve(); await Promise.resolve();
  expect(f.client.promoteLearningCandidate).not.toHaveBeenCalled();
  expect(f.client.deleteLearningCandidate).not.toHaveBeenCalled();
});

test("inactive native controls and generated message payloads cannot trigger management or candidate actions", async () => {
  const f = fixture("memory-candidates");
  await vi.waitFor(() => expect(f.find('[data-candidate-action="delete"]')).not.toBeNull());
  const forged = { source: {}, data: { kind: "abot.spark-home-widget-action", widgetId: "memory-candidates", action: "delete", id: candidate.id } };
  for (const listener of f.nativeEvents.get("message") || []) listener(forged);
  f.root.dispatch("message");
  expect(f.currentConfirmation()).toBeUndefined();
  expect(f.client.deleteLearningCandidate).not.toHaveBeenCalled();
  f.host.setActive(false); f.find('[data-candidate-action="delete"]').dispatch("click");
  expect(f.currentConfirmation()).toBeUndefined();
  expect(f.client.deleteLearningCandidate).not.toHaveBeenCalled();
});

test("fully enabled feature discovery collapses without creating a filler card", async () => {
  const f = fixture("feature-discovery");
  await vi.waitFor(() => expect(f.height).toHaveBeenLastCalledWith(0));
  expect(f.root.children).toEqual([]);
  expect(f.client.loadPassiveLearning).toHaveBeenCalled();
  expect(f.client.listPersonalSkills).toHaveBeenCalled();
  expect(f.client.listInformationBasket).toHaveBeenCalled();
});

test("HOME catalog IDs and reserved heights match the reusable native components", () => {
  expect(Object.fromEntries(SPARK_HOME_WIDGET_CATALOG.entries.map(widget => [widget.id, widget.defaultHeight])))
    .toEqual(SYSTEM_WIDGET_HEIGHTS);
});

test.each([
  ["spark-status", "learning"], ["conversations", "conversations"], ["approvals", "approvals"],
  ["recent-activity", "activity"], ["automations", "automations"], ["computer-access", "computer"],
])("%s reuses the existing Dashboard owner without loading a second set of management data", (id, entryId) => {
  const binding = { setActive: vi.fn(), dispose: vi.fn() };
  const registry = { mount: vi.fn((_root: unknown, _id: string, height: (value: number) => void) => {
    height(200); return binding;
  }) };
  const f = fixture(id, registry);
  expect(registry.mount).toHaveBeenCalledExactlyOnceWith(f.root, entryId, f.height);
  expect(binding.setActive).toHaveBeenLastCalledWith(true);
  expect(f.height).toHaveBeenLastCalledWith(200);
  expect(f.client.listPassiveLearningCandidates).not.toHaveBeenCalled();
  expect(f.client.listPersonalSkills).not.toHaveBeenCalled();
  expect(f.client.listInformationBasket).not.toHaveBeenCalled();
  f.host.setActive(false);
  expect(binding.setActive).toHaveBeenLastCalledWith(false);
  f.view.dispose(); f.view.dispose();
  expect(binding.dispose).toHaveBeenCalledOnce();
});

test("a Dashboard mount from a previous environment cannot reactivate after the environment changes", () => {
  const stale = { setActive: vi.fn(), dispose: vi.fn() };
  const fresh = { setActive: vi.fn(), dispose: vi.fn() };
  const registry = { mount: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(fresh) };
  const f = fixture("approvals", registry);
  f.setEnvironment("prod");
  expect(stale.setActive).toHaveBeenLastCalledWith(false);
  f.host.setActive(false); f.host.setActive(true);
  expect(stale.setActive).toHaveBeenLastCalledWith(false);
  const root = f.documentRoot.createElement("section");
  const view = f.host.mount(root, "approvals");
  expect(fresh.setActive).toHaveBeenLastCalledWith(true);
  f.host.destroy(); view.dispose();
  expect(stale.dispose).toHaveBeenCalledOnce();
  expect(fresh.dispose).toHaveBeenCalledOnce();
});
