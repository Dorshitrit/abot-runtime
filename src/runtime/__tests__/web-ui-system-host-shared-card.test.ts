import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only module.
import { renderSystemHostConnection } from "../../web-ui/app/components/system-host/rendering.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function render(snapshot: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  const root = document.createElement("section");
  root.innerHTML = renderSystemHostConnection({ snapshot, supported: true, compact: true, ...extra });
  return root;
}
function connected(os: string) {
  return {
    paired: true, connected: true, hostId: "private-host-id", connectionId: "socket",
    identity: { os, name: "<My computer>", user: "owner" },
    capabilities: ["macos_permission_preflight_v1"],
    readiness: { ready: true, route: "companion", platforms: [] },
  };
}

describe("shared computer connection card", () => {
  test.each(["linux", "macos", "windows"])("%s readiness uses one compact card and one removal action", (os) => {
    const root = render(connected(os));
    expect(root.querySelectorAll(".system-host-card-ready")).toHaveLength(1);
    expect(root.querySelectorAll("h2")).toHaveLength(1);
    expect(root.querySelectorAll("[data-system-host-revoke]")).toHaveLength(1);
    expect(root.querySelector(".system-host-card-description")).toBeNull();
    expect(root.querySelectorAll("[data-system-host-install]")).toHaveLength(0);
    expect(root.querySelectorAll("[data-system-host-mac]")).toHaveLength(0);
    expect(root.querySelector(".system-host-card-computer")?.textContent).toContain("<My computer>");
    expect(root.querySelector("my")).toBeNull();
    expect(root.innerHTML).not.toContain("private-host-id");
  });

  test("connected Mac hides permissions until explicitly opened and still exposes failures", () => {
    const snapshot = connected("macos");
    const root = render(snapshot);
    expect(root.querySelector("[data-system-host-management]")).toBeNull();
    expect(root.querySelector("[data-mac-permissions-check]")).toBeNull();
    const opened = render(snapshot, { managementOpen: true });
    expect(opened.querySelector("[data-system-host-management]")?.hasAttribute("open")).toBe(true);
    expect(opened.querySelector("[data-mac-permissions-check]")).not.toBeNull();
    const failure = render(snapshot, { macPermissionError: "Permission check failed." });
    expect(failure.querySelector("[data-system-host-management]")?.hasAttribute("open")).toBe(true);
    expect(failure.querySelector('[role="alert"]')).not.toBeNull();
  });

  test.each(["native", "wsl_interop"])("%s keeps direct access distinct from pairing", (route) => {
    const root = render({ paired: false, connected: false, readiness: { ready: true, route, platforms: [] } });
    expect(root.querySelector(".system-host-card-ready")).not.toBeNull();
    expect(root.querySelector("h2")?.textContent).toContain("Direct");
    expect(root.querySelector("[data-system-host-revoke]")).toBeNull();
    expect(root.querySelectorAll("[data-system-host-install]")).toHaveLength(0);
  });

  test.each([
    { platforms: ["linux"], selector: '[data-system-host-install="linux"]' },
    { platforms: ["macos"], localSetupAvailable: true, selector: '[data-system-host-mac="local"]' },
    { platforms: ["macos"], localSetupAvailable: false, selector: '[data-system-host-mac="manual"]' },
  ])("keeps the existing $selector setup action visible", ({ selector, ...readiness }) => {
    const root = render({ paired: false, connected: false, readiness: { ...readiness, ready: false } });
    expect(root.querySelector(selector)).not.toBeNull();
    expect(root.querySelector("[data-system-host-management]")).toBeNull();
    expect(root.querySelector(".system-host-card-ready")).toBeNull();
  });

  test.each([
    { error: "Connection action failed." },
    { message: "Connection is being checked." },
    { statusUnavailable: true },
    { busy: true },
  ])("does not hide feedback behind the compact success card: %j", (extra) => {
    const root = render(connected("linux"), extra);
    expect(root.querySelector(".system-host-card-ready")).toBeNull();
    expect(root.querySelector("[data-system-host-refresh]")).not.toBeNull();
    if (extra.busy) expect(root.querySelector("[data-system-host-revoke]")?.hasAttribute("disabled")).toBe(true);
    if (extra.error) expect(root.querySelector('[role="alert"]')?.textContent).toContain(extra.error);
  });

  test("keeps the Linux update action and offline identity available", () => {
    const snapshot = connected("linux");
    const root = render({ ...snapshot, connected: false,
      readiness: { ready: false, route: "companion", platforms: ["linux"], companionUpdateRequired: true } });
    expect(root.querySelector('[data-system-host-install="linux"]')).not.toBeNull();
    expect(root.querySelector("[data-system-host-revoke]")).not.toBeNull();
    expect(root.querySelector(".system-host-card-ready")).toBeNull();
    expect(root.querySelector(".system-host-card-computer")?.textContent).toContain("<My computer>");
    expect(root.querySelector("my")).toBeNull();
  });

  test("keeps Mac native permission preparation available before pairing", () => {
    const root = render({ paired: false, connected: false,
      nativePermissions: { available: true, scope: "native_runtime", environmentId: "prod", ownerId: "runtime-a", computerName: "Mac" },
      readiness: { ready: true, route: "native", platforms: [] } });
    expect(root.querySelector("[data-native-mac-permissions-check]")).not.toBeNull();
    expect(root.querySelector("[data-mac-permissions-check]")).toBeNull();
    expect(root.querySelector("[data-system-host-revoke]")).toBeNull();
  });
});
