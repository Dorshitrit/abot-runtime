import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardWorkspace } from "../../web-ui/app/components/dashboard/workspace.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createCompactHomeLayout } from "../../web-ui/app/components/dashboard/compact-layout.js";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

const approval = {
  environmentId: "dev", sessionId: "session-one", requestId: "request-one", approvalId: "approval-one",
  event: { name: "tool.approval.required", tool: "system_command", approvalId: "approval-one", meta: { command: "echo hello" } },
};
const loaded = { environmentId: "dev", composerAvailable: true, supportsSchedules: true,
  sessions: [{ id: "session-one", title: "Existing conversation", unreadCount: 2 }],
  runs: [], approvals: [approval], loadingSessions: false, loadingActivity: false };

function fixture(width = 1600) {
  const h = createHomeWidgetsHarness(width);
  const actions = { createJob: vi.fn(), continueConversation: vi.fn(), openJobs: vi.fn(),
    openConversation: vi.fn(), refresh: vi.fn(), decideApproval: vi.fn() };
  const workspace = createDashboardWorkspace({ root: h.root, actions });
  workspace.render(loaded);
  disposers.push(workspace.compactWidgets.dispose);
  const panel = (id: string) => h.root.querySelector(`[data-dashboard-${id}]`) as HomeWidgetElement;
  const mount = (id: string) => {
    const root = h.createElement("div"); h.homeRegion.append(root);
    const height = vi.fn();
    const view = workspace.compactWidgets.mount(root, id, height);
    return { root, view, height, button: () => root.querySelector("button") as HomeWidgetElement };
  };
  return { ...h, workspace, actions, panel, mount,
    sharedDialog: () => h.homeRegion.querySelector("dialog.home-widget-dialog") as HomeWidgetElement };
}

test("external previews open the original approvals outside hidden Dashboard at desktop width", () => {
  const h = fixture();
  const panel = h.panel("approvals");
  const card = panel.querySelector(".home-approval");
  const mounted = h.mount("approvals");
  expect(mounted.height).toHaveBeenLastCalledWith(200);
  expect(mounted.button().disabled).toBe(true);
  h.root.hidden = true;
  mounted.view.setActive(true);
  mounted.button().focus();
  mounted.button().dispatch("click");
  const dialog = h.sharedDialog();
  expect(dialog.parentElement).toBe(h.homeRegion);
  expect(dialog.open).toBe(true);
  expect(dialog.contains(panel)).toBe(true);
  expect(panel.querySelector(".home-approval")).toBe(card);
  panel.querySelector(".home-approval-conversation")!.dispatch("click");
  panel.querySelector(".approve")!.dispatch("click");
  expect(h.actions.openConversation).toHaveBeenCalledExactlyOnceWith("session-one", "request-one");
  expect(h.actions.decideApproval).toHaveBeenCalledExactlyOnceWith(approval, true);
  const append = h.root.appendChild.bind(h.root);
  vi.spyOn(h.root, "appendChild").mockImplementation(element => {
    if (element === dialog) expect(dialog.open).toBe(false);
    return append(element);
  });
  dialog.dispatch("cancel");
  expect(panel.parentElement).toBe(h.panel("approval-dock"));
  expect(dialog.parentElement).toBe(h.root);
  expect(h.documentRoot.activeElement).toBe(mounted.button());
});

test("external previews follow live owner updates and retain an open panel across viewport changes", () => {
  const h = fixture();
  const panel = h.panel("conversations");
  const mounted = h.mount("conversations");
  h.root.hidden = true;
  mounted.view.setActive(true); mounted.button().dispatch("click");
  const focus = h.documentRoot.activeElement;
  h.resize(1200);
  expect(h.sharedDialog().open).toBe(true);
  expect(h.sharedDialog().contains(panel)).toBe(true);
  expect(h.documentRoot.activeElement).toBe(focus);
  h.workspace.render({ ...loaded, sessions: [{ id: "session-two", title: "New reply", unreadCount: 3 }] });
  expect(mounted.button().textContent).toContain("New reply");
  panel.querySelector('[data-dashboard-action="conversation"]')!.dispatch("click");
  expect(h.actions.openConversation).toHaveBeenCalledExactlyOnceWith("session-two", undefined);
});

test.each(["deactivate", "dispose", "workspace", "unavailable"])("%s restores externally borrowed panels without taking destination focus", method => {
  const h = fixture();
  const panel = h.panel("approvals");
  const mounted = h.mount("approvals");
  mounted.view.setActive(true); mounted.button().dispatch("click");
  const destination = h.createElement("button"); h.homeRegion.append(destination); destination.focus();
  if (method === "deactivate") mounted.view.setActive(false);
  if (method === "dispose") mounted.view.dispose();
  if (method === "workspace") h.workspace.compactWidgets.setWorkspace("chat");
  if (method === "unavailable") h.workspace.compactWidgets.setEnabled(false);
  expect(h.sharedDialog().open).toBe(false);
  expect(panel.parentElement).toBe(h.panel("approval-dock"));
  expect(h.documentRoot.activeElement).toBe(destination);
  if (method !== "dispose") {
    mounted.button().dispatch("click");
    expect(h.sharedDialog().open).toBe(false);
  }
});

test("closing after live approval resolution returns its panel to the owner's current container", () => {
  const h = fixture();
  const panel = h.panel("approvals");
  const mounted = h.mount("approvals");
  mounted.view.setActive(true); mounted.button().dispatch("click");
  h.workspace.render({ ...loaded, approvals: [] });
  expect(mounted.button().textContent).toContain("No pending approvals");
  expect(h.sharedDialog().contains(panel)).toBe(true);
  mounted.view.dispose();
  expect(panel.parentElement).toBe(h.root.querySelector(".home-workspace-content"));
});

test("late entry registration and availability refresh external previews without matchMedia", () => {
  const h = createHomeWidgetsHarness(1600, false);
  const layout = createCompactHomeLayout(h); disposers.push(layout.dispose);
  layout.setEnabled(true);
  const root = h.createElement("div"); h.homeRegion.append(root);
  const height = vi.fn();
  const view = layout.mount(root, "computer", height);
  view.setActive(true);
  expect(height).toHaveBeenLastCalledWith(0);
  let available = true;
  const unregister = layout.register({ id: "computer", label: "Computer access", element: h.source,
    getSummary: () => ({ title: "Connected" }), isAvailable: () => available });
  expect(height).toHaveBeenLastCalledWith(200);
  expect(root.textContent).toContain("Connected");
  expect(layout.open("computer")).toBe(false);
  root.querySelector("button")!.dispatch("click");
  const dialog = h.homeRegion.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  available = false; layout.refresh();
  expect(dialog.open).toBe(false);
  expect(height).toHaveBeenLastCalledWith(0);
  available = true; layout.refresh();
  expect(height).toHaveBeenLastCalledWith(200);
  unregister();
  expect(height).toHaveBeenLastCalledWith(0);
  view.dispose();
  expect(root.children).toEqual([]);
});

test("unknown and duplicate external mounts do not create another interactive preview", () => {
  const h = fixture();
  const first = h.mount("conversations"); first.view.setActive(true);
  const duplicate = h.mount("conversations"); duplicate.view.setActive(true);
  const unknown = h.mount("not-a-widget"); unknown.view.setActive(true);
  expect(duplicate.height).toHaveBeenLastCalledWith(0);
  expect(unknown.height).toHaveBeenLastCalledWith(0);
  expect(duplicate.root.children).toEqual([]);
  expect(unknown.root.children).toEqual([]);
  duplicate.view.dispose(); unknown.view.dispose();
  first.button().dispatch("click");
  expect(h.sharedDialog().open).toBe(true);
});
