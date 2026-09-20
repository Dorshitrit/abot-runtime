import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createRuntimeConfigActivation } from "../../web-ui/app/components/runtime-config-activation.js";

function activationHarness({
  refresh = async (): Promise<boolean> => true,
  apply = async () => ({ activation: { status: "ready", message: "" } }),
} = {}) {
  let environmentId = "first";
  let click = async () => {};
  const status = { textContent: "" };
  const button = {
    disabled: false,
    addEventListener: (_name: string, callback: () => Promise<void>) => {
      click = callback;
    },
  };
  const panel = {
    className: "",
    innerHTML: "",
    setAttribute: vi.fn(),
    querySelector: (selector: string) => (selector === "p" ? status : button),
  };
  const root = {
    ownerDocument: { createElement: () => panel },
    prepend: vi.fn(),
  };
  const workspace = {
    beginExternalRuntimeMutation: vi.fn(() => true),
    endExternalRuntimeMutation: vi.fn(),
  };
  const applySpy = vi.fn(apply);
  const refreshSpy = vi.fn(refresh);
  const controller = createRuntimeConfigActivation({
    root,
    getWorkspace: () => workspace,
    apply: applySpy,
    refresh: refreshSpy,
    getEnvironmentId: () => environmentId,
  });
  return {
    controller,
    status,
    button,
    workspace,
    apply: applySpy,
    refresh: refreshSpy,
    click: () => click(),
    setEnvironment: (value: string) => {
      environmentId = value;
    },
  };
}

describe("saved configuration activation feedback", () => {
  test.each([false, true])(
    "preserves successful activation when refresh %s fails",
    async (throws) => {
      const harness = activationHarness({
        refresh: async () => {
          if (throws) throw new Error("catalog unavailable");
          return false;
        },
      });
      await harness.click();
      expect(harness.apply).toHaveBeenCalledOnce();
      expect(harness.refresh).toHaveBeenCalledOnce();
      expect(harness.status.textContent).toMatch(
        /Changes applied.*Refresh configuration/,
      );
      expect(harness.button.disabled).toBe(false);
      expect(
        harness.workspace.endExternalRuntimeMutation,
      ).toHaveBeenCalledOnce();
    },
  );

  test("retains a blocked activation as pending and does not refresh or claim it applied", async () => {
    const harness = activationHarness({
      apply: async () => ({
        activation: {
          status: "restart_required",
          message: "An active request is still running.",
        },
      }),
    });
    await harness.click();
    expect(harness.status.textContent).toBe(
      "An active request is still running.",
    );
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.button.disabled).toBe(false);
  });

  test("ignores an activation result from a previous environment", async () => {
    let finish!: (value: {
      activation: { status: string; message: string };
    }) => void;
    const pending = new Promise<{
      activation: { status: string; message: string };
    }>((resolve) => {
      finish = resolve;
    });
    const harness = activationHarness({ apply: () => pending });
    const first = harness.click();
    await harness.click();
    expect(harness.apply).toHaveBeenCalledOnce();
    harness.setEnvironment("second");
    finish({ activation: { status: "ready", message: "" } });
    await first;
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.status.textContent).toContain("Environment changed");
  });
});
