import { expect, test, vi } from "vitest";
import {
  capabilitySnapshot,
  pluginCapabilityHarness,
} from "./support/plugin-capability-ui-harness.js";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createConfigWorkspacePersistence } from "../../web-ui/app/components/config-workspace/workspace-persistence.js";

test.each([
  { reason: "unsaved", enabled: true },
  { reason: "unsaved", enabled: false },
  { reason: "busy", enabled: true },
  { reason: "busy", enabled: false },
])(
  "$reason configuration guard restores a rejected capability toggle from enabled=$enabled",
  async ({ reason, enabled }) => {
    const snapshot = structuredClone(capabilitySnapshot);
    snapshot.plugins[0]!.capabilities[0]!.enabled = enabled;
    snapshot.plugins[0]!.selectedCapabilityCount = enabled ? 2 : 1;
    snapshot.plugins[0]!.state = enabled ? "enabled" : "partial";
    const harness = pluginCapabilityHarness({ snapshot });
    const status = { textContent: "", className: "" };
    const workspaceState = {
      savingKeys: new Set(),
      externalRuntimeMutationInFlight: reason === "busy",
    };
    const workspace = createConfigWorkspacePersistence({
      state: workspaceState,
      dom: { configStatus: status },
      hasUnsavedChanges: () => reason === "unsaved",
      dashboardIsBusy: () => reason === "busy",
      setWorkspaceStatus: (message: string, className: string) => {
        status.textContent = message;
        status.className = className;
      },
      syncDashboardInteractivity: vi.fn(),
    });
    harness.dependencies.beginRuntimeMutation.mockImplementation(
      workspace.beginExternalRuntimeMutation,
    );
    await harness.manager.load();
    harness.manager.markApplied();
    harness.openTools();
    harness.viewport.scrollTop = 280;
    harness.toolsList().scrollTop = 140;

    // The native input updates checked before dispatching its change event.
    await harness.changeCapability("read_file", !enabled);

    expect(
      harness.dependencies.beginRuntimeMutation,
    ).toHaveBeenCalledExactlyOnceWith("plugin settings");
    expect(harness.capabilityControl("read_file").checked).toBe(enabled);
    expect(harness.capabilityControl("write_file").checked).toBe(true);
    expect(harness.snapshot).toEqual(snapshot);
    expect(harness.document.activeElement).toBe(
      harness.capabilityControl("read_file"),
    );
    expect(harness.toolsPanel().hidden).toBe(false);
    expect(harness.viewport.scrollTop).toBe(280);
    expect(harness.toolsList().scrollTop).toBe(140);
    expect(status.className).toBe("error-text");
    expect(status.textContent).toBe(
      reason === "unsaved"
        ? "Save or reset configuration changes before changing Runtime plugin settings."
        : "Wait for the current configuration operation before changing Runtime plugin settings.",
    );
    expect(harness.root.innerHTML).toContain(
      "Plugin selection applied to this environment.",
    );
    expect(harness.dependencies.setPlugin).not.toHaveBeenCalled();
    expect(harness.dependencies.onConfigurationSaved).not.toHaveBeenCalled();
    expect(harness.dependencies.refreshRuntimeConfig).not.toHaveBeenCalled();
    expect(harness.dependencies.endRuntimeMutation).not.toHaveBeenCalled();
    expect(workspaceState.externalRuntimeMutationInFlight).toBe(
      reason === "busy",
    );
  },
);
