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
    textContent: "Restart runtime",
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
  const existingControls = { name: "configuration and operations controls" };
  const children: unknown[] = [existingControls];
  const root = {
    ownerDocument: { createElement: () => panel },
    append: (node: unknown) => children.push(node),
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
    children,
    existingControls,
    panel,
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
  test("places the restart explanation and existing action after configuration content", () => {
    const harness = activationHarness();
    expect(harness.children).toEqual([harness.existingControls, harness.panel]);
    expect(harness.panel.innerHTML).toContain('role="status"');
    harness.controller.markPending();
    expect(harness.status.textContent).toContain("Restart");
    expect(harness.button.textContent).toBe("Apply & restart");
    expect(harness.apply).not.toHaveBeenCalled();
  });

  test("restarts unchanged saved settings and keeps unsaved-edit protection", async () => {
    const harness = activationHarness();
    harness.workspace.beginExternalRuntimeMutation.mockReturnValueOnce(false);
    await harness.click();
    expect(harness.apply).not.toHaveBeenCalled();
    await harness.click();
    expect(harness.apply).toHaveBeenCalledOnce();
    expect(harness.status.textContent).toMatch(/Runtime restarted/);
    harness.controller.markPending();
    expect(harness.button.textContent).toBe("Apply & restart");
    await harness.click();
    expect(harness.button.textContent).toBe("Restart runtime");
  });

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
        /Runtime restarted.*Refresh configuration/,
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
