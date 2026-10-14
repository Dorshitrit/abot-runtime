import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only module.
import { dashboardWidgetSummaries } from "../../web-ui/app/components/dashboard/widget-summaries.js";
// @ts-expect-error Browser-only module.
import { computerAccessWidgetSummary } from "../../web-ui/app/components/system-host/home-widget-summary.js";

const mac = () => ({
  paired: true, connected: true, hostId: "host", connectionId: "connection",
  identity: { os: "macos", name: "Work Mac" },
  capabilities: ["macos_permission_preflight_v1"],
  readiness: { ready: true, route: "companion", platforms: [] },
  nativePermissions: { available: true, scope: "native_runtime", ownerId: "owner", environmentId: "dev" },
});
const permissions = (accessibility = "granted") => ({
  screenRecording: "granted", accessibility,
});
const companionReceipt = (accessibility = "granted") => ({
  hostId: "host", connectionId: "connection", permissions: permissions(accessibility),
});
const nativeReceipt = () => ({
  scope: "native_runtime", ownerId: "owner", environmentId: "dev", permissions: permissions(),
});

describe("compact Home dashboard summaries", () => {
  test("latest conversation uses existing recency and counts all unread messages", () => {
    const snapshot = { sessions: [
      { id: "older", title: "Old unread", updatedAt: 1, unreadCount: 4 },
      { id: "newest", title: "Latest work", updatedAt: 3, unreadCount: 0 },
      { id: "middle", title: "Other work", updatedAt: 2, unreadCount: 2 },
    ] };
    const before = structuredClone(snapshot);
    const summary = dashboardWidgetSummaries(snapshot).conversations;
    expect(summary).toMatchObject({ title: "Latest work", status: "6 unread messages", tone: "active" });
    expect(snapshot).toEqual(before);
  });

  test("uses canonical overview rows and total unread availability", () => {
    const snapshot = {
      sessions: [{ id: "wrong", title: "Wrong list" }],
      sessionOverview: {
        sessions: [{ id: "right", title: "Overview conversation" }],
        unreadCount: 8, hasUnavailableReadState: false,
      },
    };
    expect(dashboardWidgetSummaries(snapshot).conversations).toMatchObject({
      title: "Overview conversation", status: "8 unread messages",
    });
    snapshot.sessionOverview.hasUnavailableReadState = true;
    const unavailable = dashboardWidgetSummaries(snapshot).conversations;
    expect(unavailable.detail).toContain("unavailable");
    expect(unavailable.status).not.toContain("8");
  });

  test("failed and loading reads do not claim successful empty state", () => {
    const failed = dashboardWidgetSummaries({
      sessionsError: "read failed", activityError: "read failed", approvalsError: "read failed",
    });
    for (const key of ["conversations", "activity", "approvals"])
      expect(failed[key]).toMatchObject({ status: "Status unavailable", tone: "attention" });
    const loading = dashboardWidgetSummaries({
      loadingSessions: true, loadingActivity: true, loadingApprovals: true,
    });
    for (const key of ["conversations", "activity", "approvals"])
      expect(loading[key].status).toBe("Loading");
  });

  test("retained activity is identified without claiming a successful refresh", () => {
    const summary = dashboardWidgetSummaries({
      activityError: "failed",
      runs: [{ id: "known", title: "Saved run", scheduledAt: 10, status: "succeeded" }],
    }).activity;
    expect(summary).toMatchObject({ title: "Saved run", status: "Status unavailable", tone: "attention" });
  });

  test("schedule chronology and outcomes remain distinct from live Studio runs", () => {
    const snapshot = {
      runs: [
        { id: "old", title: "Old schedule", scheduledAt: 1, finishedAt: 99, status: "succeeded" },
        { id: "new", title: "New schedule", scheduledAt: 2, status: "failed" },
      ],
      activeAutomations: [{ id: "studio", title: "Live workflow", latestRunStatus: "running" }],
    };
    const summaries = dashboardWidgetSummaries(snapshot);
    expect(summaries.activity).toMatchObject({ title: "New schedule", status: "Failed", tone: "failed" });
    expect(summaries.automations).toMatchObject({ title: "1 automation in progress", detail: "Live workflow", tone: "active" });
    expect(dashboardWidgetSummaries({ runs: snapshot.runs }).automations.status).toBe("No active runs");
  });

  test("unavailable automation status preserves last-seen fact without calling it live", () => {
    const summary = dashboardWidgetSummaries({
      automationStatusUnavailable: true,
      activeAutomations: [{ title: "Known workflow" }],
    }).automations;
    expect(summary).toMatchObject({ detail: "Known workflow", status: "1 last seen in progress", tone: "attention" });
  });

  test("unsupported sections and empty or failed approval decisions stay distinct", () => {
    const unsupported = dashboardWidgetSummaries({ supportsSchedules: false, supportsToolApprovals: false });
    expect(unsupported.activity.status).toBe("Unavailable");
    expect(unsupported.approvals.status).toBe("Unavailable");
    expect(dashboardWidgetSummaries({}).approvals.status).toBe("Nothing waiting");
    expect(dashboardWidgetSummaries({ approvals: [{ approvalId: "one" }] }).approvals).toMatchObject({
      title: "1 action waiting", status: "Needs review", tone: "attention",
    });
    expect(dashboardWidgetSummaries({ approvalDecisionError: "failed" }).approvals).toMatchObject({
      status: "Needs attention", tone: "attention",
    });
  });

  test("SPARK state uses existing presentation and rejects another environment", () => {
    const learning = {
      environmentId: "dev",
      status: { preferences: { enabled: false, processingPaused: true, proactiveEnabled: false } },
    };
    const current = dashboardWidgetSummaries({ environmentId: "dev" }, learning).learning;
    expect(current.status).toBe("Taking a pause");
    const stale = dashboardWidgetSummaries({ environmentId: "prod" }, learning).learning;
    expect(stale.status).toBe("Connecting");
    const failed = dashboardWidgetSummaries({}, { statusError: "failed" }).learning;
    expect(failed).toMatchObject({ status: "Status unavailable", tone: "attention" });
  });
});

describe("compact Home computer summary", () => {
  test("connected remains separate from unchecked, granted and required Mac permissions", () => {
    const state = { snapshot: mac() };
    expect(computerAccessWidgetSummary(state)).toMatchObject({
      title: "Work Mac", status: "Connected", tone: "neutral",
    });
    expect(computerAccessWidgetSummary(state).detail).toContain("not checked");
    const granted = {
      ...state, macPermissions: companionReceipt(), nativeMacPermissions: nativeReceipt(),
    };
    expect(computerAccessWidgetSummary(granted).detail).toBe("SYSTEM · granted · Companion · granted");
    const required = computerAccessWidgetSummary({ ...granted, macPermissions: companionReceipt("required") });
    expect(required).toMatchObject({ status: "Connected", tone: "attention" });
    expect(required.detail).toContain("Companion · action needed");
  });

  test("receipt from another connection or native owner cannot imply granted access", () => {
    const summary = computerAccessWidgetSummary({
      snapshot: mac(),
      macPermissions: { ...companionReceipt(), connectionId: "old" },
      nativeMacPermissions: { ...nativeReceipt(), ownerId: "old" },
    });
    expect(summary.detail).toBe("SYSTEM · not checked · Companion · not checked");
    expect(summary.tone).toBe("neutral");
  });

  test.each(["native", "wsl_interop"])("%s direct readiness does not invent Companion pairing", (route) => {
    const summary = computerAccessWidgetSummary({
      snapshot: { connected: false, paired: false, readiness: { ready: true, route } },
    });
    expect(summary).toMatchObject({ status: "Ready", tone: "success" });
    expect(summary.title).toContain("Direct");
  });

  test("native Windows local tools do not require companion readiness", () => {
    const snapshot = {
      collectionSource: { mode: "native", platform: "windows" },
      connected: false, paired: false, readiness: { ready: false, directAccessReady: true },
    };
    expect(computerAccessWidgetSummary({ snapshot }).status).toBe("Local");
    const unavailable = computerAccessWidgetSummary({
      snapshot: { ...snapshot, readiness: { ...snapshot.readiness, directAccessReady: false } },
    });
    expect(unavailable.status).toBe("Check needed");
  });

  test("Windows pairing stages reuse their live invitation and attempt", () => {
    const snapshot = {
      paired: false, connected: false,
      readiness: { ready: false, route: "setup_required", platforms: ["windows"] },
    };
    const invitation = { expiresAt: "2100-01-01T00:00:00Z", launchUrl: "abot-companion://connect?invitation=example" };
    expect(computerAccessWidgetSummary({ snapshot, windowsStoreInvitation: invitation }).status).toBe("Waiting for you");
    expect(computerAccessWidgetSummary({ snapshot, windowsStoreAttempt: { phase: "waiting" }, windowsStoreInvitation: invitation }).status).toBe("Waiting for approval");
    expect(computerAccessWidgetSummary({ snapshot, windowsStoreAttempt: { phase: "expired" } }).status).toBe("Expired");
  });

  test("offline, permission failures and unavailable checks remain visible", () => {
    const snapshot = mac();
    const offline = computerAccessWidgetSummary({
      snapshot: { ...snapshot, connected: false, readiness: { ready: false, route: "companion" } },
    });
    expect(offline.status).toBe("Paired · offline");
    const permissionFailure = computerAccessWidgetSummary({ snapshot, macPermissionError: "Check failed" });
    expect(permissionFailure).toMatchObject({ detail: "Check failed", status: "Connected", tone: "attention" });
    expect(computerAccessWidgetSummary({ snapshot, statusUnavailable: true })).toMatchObject({
      status: "Status unavailable", tone: "attention",
    });
    expect(computerAccessWidgetSummary({ snapshot, busy: true }).status).toBe("Checking");
    expect(computerAccessWidgetSummary({}, false).status).toBe("Unavailable");
    expect(computerAccessWidgetSummary().status).toBe("Checking");
  });
});
