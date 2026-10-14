import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only module.
import { computerAccessWidgetSummary } from "../../web-ui/app/components/system-host/home-widget-summary.js";

const snapshot = () => ({
  paired: true, connected: true, hostId: "host", connectionId: "connection",
  identity: { os: "macos", name: "Work Mac" },
  capabilities: ["macos_permission_preflight_v1"],
  readiness: { ready: true, route: "companion", platforms: [] },
  nativePermissions: { available: true, scope: "native_runtime", ownerId: "owner", environmentId: "dev" },
});
const permissions = () => ({ screenRecording: "granted", accessibility: "granted" });
const grantedState = () => ({
  snapshot: snapshot(),
  macPermissions: { hostId: "host", connectionId: "connection", permissions: permissions() },
  nativeMacPermissions: { scope: "native_runtime", ownerId: "owner", environmentId: "dev", permissions: permissions() },
});
const permissionIndicator = (state: object) => computerAccessWidgetSummary(state).preview.items[1].indicator;

describe("Home computer preview", () => {
  test("keeps identity, OS and connection separate from missing permission receipts", () => {
    const state = { snapshot: snapshot() };
    const before = structuredClone(state);
    expect(computerAccessWidgetSummary(state).preview).toEqual({
      kind: "computer", title: "Work Mac", detail: "macOS",
      items: [
        { label: "Connection", indicator: { icon: "success", label: "Connected", tone: "success" } },
        { label: "Permissions", indicator: { icon: "unknown", label: "Not checked", tone: "neutral" } },
      ],
    });
    expect(state).toEqual(before);
  });

  test("requires both companion and native receipts when both scopes apply", () => {
    const state = grantedState();
    for (const key of ["macPermissions", "nativeMacPermissions"]) {
      expect(permissionIndicator({ ...state, [key]: null })).toMatchObject({
        label: "Not checked", tone: "neutral",
      });
    }
  });

  test("rejects stale connection, host, native owner and environment receipts", () => {
    const state = grantedState();
    const staleStates = [
      { ...state, macPermissions: { ...state.macPermissions, connectionId: "old" } },
      { ...state, macPermissions: { ...state.macPermissions, hostId: "other" } },
      { ...state, nativeMacPermissions: { ...state.nativeMacPermissions, ownerId: "old" } },
      { ...state, nativeMacPermissions: { ...state.nativeMacPermissions, environmentId: "prod" } },
    ];
    for (const stale of staleStates)
      expect(permissionIndicator(stale)).toMatchObject({ icon: "unknown", tone: "neutral" });
  });

  test("grants only current receipts and preserves the existing summary fields", () => {
    const summary = computerAccessWidgetSummary(grantedState());
    expect(summary).toMatchObject({
      title: "Work Mac", detail: "SYSTEM · granted · Companion · granted", status: "Connected", tone: "neutral",
    });
    expect(summary.preview.items[1].indicator).toEqual({ icon: "success", label: "Granted", tone: "success" });
  });

  test("keeps required and unavailable permissions distinguishable", () => {
    const state = grantedState();
    const required = {
      ...state, macPermissions: { ...state.macPermissions, permissions: { ...permissions(), accessibility: "required" } },
    };
    const unavailable = {
      ...state, snapshot: { ...state.snapshot, nativePermissions: { ...state.snapshot.nativePermissions, available: false } },
    };
    expect(permissionIndicator(required)).toEqual({ icon: "failed", label: "Required", tone: "attention" });
    expect(permissionIndicator(unavailable)).toEqual({ icon: "paused", label: "Unavailable", tone: "neutral" });
  });

  test("retains feedback and loading instead of a healthy preview", () => {
    const state = grantedState();
    for (const key of ["error", "actionError", "macPermissionError", "nativeMacPermissionError", "message"]) {
      const summary = computerAccessWidgetSummary({ ...state, [key]: "Check failed" });
      expect(summary.detail).toBe("Check failed");
      expect(summary.preview).toBeUndefined();
    }
    expect(computerAccessWidgetSummary({ ...state, busy: true })).toMatchObject({ status: "Checking", tone: "neutral" });
    expect(computerAccessWidgetSummary({ ...state, busy: true }).preview).toBeUndefined();
  });

  test("preserves setup, offline, unavailable, native Windows and Store fallbacks", () => {
    const state = grantedState();
    const cases = [
      { ...state, snapshot: { ...state.snapshot, connected: false, readiness: { ready: false } } },
      { ...state, snapshot: { ...state.snapshot, readiness: { ready: false } } },
      { ...state, downloaded: { filename: "setup" } },
      { ...state, manualMac: { command: "setup" } },
      { ...state, statusUnavailable: true },
      { snapshot: { collectionSource: { mode: "native", platform: "windows" }, readiness: { directAccessReady: true } } },
      { snapshot: { connected: false, readiness: { ready: false, route: "setup_required", platforms: ["windows"] } } },
      {},
    ];
    for (const input of cases) expect(computerAccessWidgetSummary(input).preview).toBeUndefined();
    expect(computerAccessWidgetSummary(state, false).preview).toBeUndefined();
  });
});
