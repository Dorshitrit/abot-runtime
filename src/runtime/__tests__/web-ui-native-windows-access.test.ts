import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { isNativeWindowsLocalAccess } from "../../web-ui/app/components/system-host/native-windows-access.js";
// @ts-expect-error Browser-only module.
import { hostSetupIsReady, renderSystemHostConnection } from "../../web-ui/app/components/system-host/rendering.js";
// @ts-expect-error Browser-only module.
import { macCompanionPermissionPath, renderMacPermissionGuide } from "../../web-ui/app/components/system-host/macos-permissions.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function nativeSnapshot(directAccessReady = true) {
  return { paired: false, connected: false,
    collectionSource: { mode: "native", platform: "windows" },
    readiness: { ready: false, route: "setup_required", environment: "native",
      platforms: ["windows"], restartRequired: false, directAccessReady } };
}
function render(snapshot: unknown = nativeSnapshot(), extra: Record<string, unknown> = {}) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  const root = document.createElement("section");
  root.innerHTML = renderSystemHostConnection({ snapshot, supported: true, ...extra });
  return root;
}
afterEach(() => vi.unstubAllGlobals());

describe("native Windows access presentation", () => {
  test("native collection omits permission instructions for an old Mac Companion", () => {
    const snapshot = { ...nativeSnapshot(), paired: true,
      identity: { os: "macos", homeDir: "/fixture/old-mac" }, companion: { installedVersion: 6 } };
    expect(macCompanionPermissionPath(snapshot)).toBe("");
    expect(renderMacPermissionGuide(snapshot)).toBe("");
  });
  test.each([true, false])("native source avoids pairing independently of command discovery (%s)", (direct) => {
    const snapshot = nativeSnapshot(direct), before = structuredClone(snapshot), root = render(snapshot);
    expect(isNativeWindowsLocalAccess(snapshot)).toBe(true);
    expect(root.querySelector("[data-system-host-native-windows]")).not.toBeNull();
    for (const selector of ["[data-system-host-store-setup]", "[data-system-host-revoke]", "[data-system-host-install]", '[data-tone="ready"]'])
      expect(root.querySelector(selector)).toBeNull();
    expect(root.querySelector("[data-system-host-refresh]")).not.toBeNull();
    expect(hostSetupIsReady(snapshot)).toBe(false);
    expect(snapshot).toEqual(before);
  });
  test.each([undefined, { mode: "companion", platform: "windows" },
    { mode: "companion", platform: "linux" }, { mode: "companion", platform: "macos" },
    { mode: "native", platform: "linux" }, { mode: "native", platform: "unsupported" },
  ])("uses server source instead of browser or readiness inference: %j", (collectionSource) => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows NT 10.0" });
    const snapshot = { ...nativeSnapshot(), collectionSource };
    expect(isNativeWindowsLocalAccess(snapshot)).toBe(false);
    expect(render(snapshot).querySelector("[data-system-host-native-windows]")).toBeNull();
  });
  test.each([true, false])("keeps an existing paired native source local when Companion connected=%s", (connected) => {
    const snapshot = { ...nativeSnapshot(), paired: true, connected,
      identity: { os: "windows", name: "Existing Companion" },
      readiness: { ready: connected, route: "companion", platforms: [] } };
    const root = render(snapshot, { compact: true,
      windowsStoreAttempt: { phase: "waiting" }, windowsStoreInvitation: { expiresAt: "2099-01-01T00:00:00Z" } });
    expect(root.querySelector("[data-system-host-native-windows]")).not.toBeNull();
    for (const selector of ["[data-system-host-store-setup]", "[data-system-host-management]", "[data-system-host-revoke]"])
      expect(root.querySelector(selector)).toBeNull();
    expect(root.querySelector(".system-host-card-ready-title")?.textContent).toContain("Windows access is local");
  });
  test("only explicit failed command discovery shows a warning", () => {
    const root = render(nativeSnapshot(false), { compact: true });
    expect(root.querySelector(".system-host-card-status")?.textContent).toBe("Check needed");
    expect(root.querySelector("[data-system-host-refresh]")).not.toBeNull();
    const unknown = render({ collectionSource: { mode: "native", platform: "windows" } });
    expect(unknown.querySelector(".system-host-card-status")?.textContent).toBe("Local");
  });
  test.each([{ busy: true, status: "Checking" }, { statusUnavailable: true, status: "Status unavailable" }])(
    "does not present cached access as current during %s", ({ status, ...extra }) => {
      const root = render(nativeSnapshot(), { compact: true, ...extra });
      expect(root.querySelector(".system-host-card-ready")).toBeNull();
      expect(root.querySelector(".system-host-card-status")?.textContent).toBe(status);
      expect(root.querySelector("h2")?.textContent).not.toContain("Windows access is local");
      expect(root.querySelector("[data-system-host-store-setup]")).toBeNull();
    },
  );
  test("retains feedback and unsupported backend status", () => {
    const root = render(nativeSnapshot(), { compact: true, error: "Status failed." });
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Status failed.");
    const unsupported = render(nativeSnapshot(), { supported: false });
    expect(unsupported.querySelector("[data-system-host-native-windows]")).toBeNull();
    expect(unsupported.querySelector(".system-host-card-status")?.textContent).toBe("Unavailable");
  });
});
