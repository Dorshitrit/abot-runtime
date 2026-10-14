import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardWorkspace } from "../../web-ui/app/components/dashboard/workspace.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createComputerAccessFeature } from "../../web-ui/app/computer-access-feature.js";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.useRealTimers();
});

const approval = {
  environmentId: "dev", sessionId: "session-one", requestId: "request-one", approvalId: "approval-one",
  event: { name: "tool.approval.required", tool: "system_command", approvalId: "approval-one", meta: { command: "echo hello" } },
};
const loaded = {
  environmentId: "dev", composerAvailable: true, supportsSchedules: true,
  sessions: [{ id: "session-one", title: "Existing conversation", unreadCount: 2 }],
  runs: [], approvals: [], loadingSessions: false, loadingActivity: false,
};
const pending = { ...loaded, approvals: [approval] };

function createWorkspace(width = 1280, passiveLearning?: { mountHome: ReturnType<typeof vi.fn>; snapshot?: () => unknown }) {
  const h = createHomeWidgetsHarness(width);
  const actions = {
    createJob: vi.fn(), continueConversation: vi.fn(), openJobs: vi.fn(),
    openConversation: vi.fn(), refresh: vi.fn(), decideApproval: vi.fn(),
  };
  const workspace = createDashboardWorkspace({ root: h.root, actions, passiveLearning });
  workspace.render(loaded);
  disposers.push(workspace.compactWidgets.dispose);
  const panel = (name: string) => h.root.querySelector(`[data-dashboard-${name}]`) as HomeWidgetElement;
  return { ...h, workspace, actions, panel };
}

describe("Home widgets share existing dashboard owners", () => {
  test("approvals keep their live cards and exact callbacks through repeated dashboard refreshes in expansion", () => {
    const h = createWorkspace();
    h.workspace.render(pending);
    const approvals = h.panel("approvals");
    const card = approvals.querySelector(".home-approval");
    expect(h.workspace.compactWidgets.open("approvals")).toBe(true);
    h.workspace.render({ ...pending, runs: [{ id: "run-two", title: "New activity", status: "succeeded" }] });
    h.workspace.render(pending);
    expect(h.dialog()!.contains(approvals)).toBe(true);
    expect(approvals.querySelector(".home-approval")).toBe(card);
    approvals.querySelector(".home-approval-conversation")!.dispatch("click");
    approvals.querySelector(".approve")!.dispatch("click");
    expect(h.actions.openConversation).toHaveBeenCalledExactlyOnceWith("session-one", "request-one");
    expect(h.actions.decideApproval).toHaveBeenCalledExactlyOnceWith(approval, true);
    h.workspace.compactWidgets.close();
    expect(approvals.parentElement).toBe(h.panel("approval-dock"));
  });

  test("resolving approvals during expansion returns their panel to current content ownership on close", () => {
    const h = createWorkspace();
    h.workspace.render(pending);
    const approvals = h.panel("approvals");
    h.workspace.compactWidgets.open("approvals");
    h.workspace.render(loaded);
    expect(h.dialog()!.contains(approvals)).toBe(true);
    expect(approvals.hidden).toBe(true);
    expect(h.panel("approval-dock").hidden).toBe(true);
    const feedback = h.dialog()!.querySelector('[role="status"]')!;
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toContain(h.button("approvals")!.querySelector(".home-widget-title")!.textContent);
    h.workspace.compactWidgets.close();
    expect(approvals.parentElement).toBe(h.root.querySelector(".home-workspace-content"));
  });

  test("an approval refresh error remains visible in expansion and returns outside the hidden dock", () => {
    const h = createWorkspace();
    h.workspace.render(pending);
    const approvals = h.panel("approvals");
    h.workspace.compactWidgets.open("approvals");
    h.workspace.render({ ...loaded, approvalsError: "Connection interrupted" });
    expect(h.dialog()!.contains(approvals)).toBe(true);
    expect(approvals.hidden).toBe(false);
    expect(approvals.textContent).toContain("Connection interrupted");
    h.workspace.compactWidgets.close();
    expect(approvals.parentElement).toBe(h.root.querySelector(".home-workspace-content"));
    expect(h.panel("approval-dock").hidden).toBe(true);
  });

  test("large screens retain pending approvals beside the unchanged composer", () => {
    const h = createWorkspace(1600);
    const composer = h.createElement("textarea");
    composer.value = "Unsent message";
    h.workspace.composerHost.append(composer);
    h.workspace.render(pending);
    const approvals = h.panel("approvals");
    expect(approvals.parentElement).toBe(h.panel("approval-dock"));
    expect(h.panel("approval-dock").hidden).toBe(false);
    expect(h.homeRegion.classList.contains("home-widgets-compact")).toBe(false);
    expect(h.workspace.compactWidgets.open("approvals")).toBe(false);
    h.workspace.render(pending);
    expect(h.workspace.composerHost.contains(composer)).toBe(true);
    expect(composer.value).toBe("Unsent message");
    h.workspace.render(loaded);
    expect(h.panel("approval-dock").hidden).toBe(true);
  });

  test("asynchronous Spark updates refresh their widget without remounting the live home component", async () => {
    let statusError = "";
    let refreshWidget: () => void = () => {};
    const mountHome = vi.fn((root: HomeWidgetElement, refresh: () => void) => {
      root.textContent = "Existing live Spark view";
      refreshWidget = refresh;
    });
    const h = createWorkspace(1280, { mountHome, snapshot: () => ({ environmentId: "dev", statusError }) });
    const learning = h.panel("learning");
    h.workspace.compactWidgets.open("learning");
    await Promise.resolve();
    statusError = "offline";
    refreshWidget();
    expect(h.button("learning")!.textContent).toContain("Status unavailable");
    expect(h.dialog()!.contains(learning)).toBe(true);
    expect(learning.textContent).toBe("Existing live Spark view");
    expect(mountHome).toHaveBeenCalledOnce();
  });
});

test("computer access opens the existing manager in its widget and keeps Home polling after collapse", async () => {
  vi.useFakeTimers();
  const h = createWorkspace();
  const snapshot = {
    paired: true, connected: true, hostId: "mac-one", connectionId: "connection-one",
    identity: { name: "MacBook", os: "macos", user: "alice" },
    readiness: { ready: true, route: "companion", platforms: [] },
    capabilities: ["macos_permission_preflight_v1"],
  };
  const runtimeClient = {
    getSystemHostConnection: vi.fn(async () => snapshot),
    supportsSystemHostConnection: vi.fn(() => true),
    requestSystemHostPermissions: vi.fn(), revokeSystemHostConnection: vi.fn(),
  };
  const homeWorkspaceButton = { click: vi.fn(() => {
    h.homeRegion.hidden = false;
    h.workspace.compactWidgets.setWorkspace("home");
  }) };
  const feature = createComputerAccessFeature({
    dom: { homeDashboardRoot: h.root, homeWorkspacePanel: h.homeRegion, homeWorkspaceButton },
    runtimeClient, getEnvironmentId: () => "dev", compactHomeWidgets: h.workspace.compactWidgets,
  });
  disposers.push(feature.dispose);
  await vi.advanceTimersByTimeAsync(0);
  const card = h.homeRegion.querySelector(".home-computer-access")!;
  expect(h.root.querySelectorAll("button[data-home-widget]")
    .filter((button) => !button.hidden).map((button) => button.dataset.homeWidget))
    .toEqual(["conversations", "approvals", "activity", "automations", "computer"]);
  expect(h.button("computer")!.textContent).toContain("MacBook");
  expect(runtimeClient.getSystemHostConnection).toHaveBeenCalledOnce();
  h.workspace.compactWidgets.setWorkspace("chat");
  h.homeRegion.hidden = true;
  expect(feature.open()).toBe(true);
  expect(homeWorkspaceButton.click).toHaveBeenCalledOnce();
  expect(h.dialog()!.contains(card)).toBe(true);
  expect(feature.state.managementOpen).toBe(true);
  expect(h.documentRoot.activeElement).toBe(card);
  expect(runtimeClient.requestSystemHostPermissions).not.toHaveBeenCalled();
  h.workspace.compactWidgets.close();
  expect(card.parentElement).toBe(h.homeRegion);
  expect(card.hidden).toBe(false);
  expect(h.homeRegion.querySelectorAll(".home-computer-access")).toEqual([card]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(2);
  expect(h.button("computer")!.textContent).toContain("MacBook");
});
