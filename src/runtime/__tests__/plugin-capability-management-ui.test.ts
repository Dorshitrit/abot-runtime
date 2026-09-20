import { describe, expect, test, vi } from "vitest";
import {
  capabilitySnapshot,
  pluginCapabilityHarness,
} from "./support/plugin-capability-ui-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderPluginManager } from "../../web-ui/app/components/plugins/rendering.js";

describe("individual plugin capability controls", () => {
  test("saves one exact tool through its native control and preserves the other tool", async () => {
    const harness = pluginCapabilityHarness();
    await harness.manager.load();
    expect(harness.toolsPanel().hidden).toBe(true);
    harness.openTools();
    harness.toolsList().scrollTop = 140;
    await harness.changeCapability("read_file", false);
    expect(harness.dependencies.setPlugin).toHaveBeenCalledExactlyOnceWith({
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: false,
    });
    expect(harness.capabilityControl("read_file").checked).toBe(false);
    expect(harness.capabilityControl("write_file").checked).toBe(true);
    expect(harness.dependencies.onConfigurationSaved).toHaveBeenCalledOnce();
    expect(harness.root.innerHTML).toContain("Apply changes");
    expect(harness.toolsPanel().hidden).toBe(false);
    expect(harness.document.activeElement).toBe(
      harness.capabilityControl("read_file"),
    );
  });

  test("preserves the tools view, keyboard focus and both scroll positions through a full configuration remount", async () => {
    let harness!: ReturnType<typeof pluginCapabilityHarness>;
    harness = pluginCapabilityHarness({
      refresh: async () => {
        harness.viewport.inert = true;
        harness.remount();
        harness.viewport.scrollTop = 0;
        await harness.manager.load();
        harness.viewport.inert = false;
        return true;
      },
    });
    await harness.manager.load();
    harness.openTools();
    harness.toolsList().scrollTop = 140;
    await harness.changeCapability("read_file", false);
    expect(harness.toolsPanel().hidden).toBe(false);
    expect(harness.document.activeElement).toBe(
      harness.capabilityControl("read_file"),
    );
    expect(harness.viewport.scrollTop).toBe(280);
    expect(harness.toolsList().scrollTop).toBe(140);
    harness.manager.markApplied();
    expect(harness.toolsPanel().hidden).toBe(false);
    expect(harness.root.innerHTML).toContain("applied to this environment");
  });

  test("keeps the master on when all tools are off and lets one child be enabled", async () => {
    const snapshot = structuredClone(capabilitySnapshot);
    snapshot.plugins[0]!.capabilities = snapshot.plugins[0]!.capabilities.map(
      (capability) => ({ ...capability, enabled: false }),
    );
    snapshot.plugins[0]!.selectedCapabilityCount = 0;
    snapshot.plugins[0]!.state = "disabled";
    const harness = pluginCapabilityHarness({ snapshot });
    await harness.manager.load();
    expect(harness.root.innerHTML).toContain('aria-label="Disable filesystem"');
    expect(harness.root.innerHTML).toContain("No tools selected");
    expect(harness.capabilityControl("read_file").disabled).toBe(false);
    harness.openTools();
    await harness.changeCapability("read_file", true);
    expect(harness.capabilityControl("read_file").checked).toBe(true);
    expect(harness.capabilityControl("write_file").checked).toBe(false);
  });

  test.each(["parent", "global", "capability"])(
    "disables a tool blocked by %s policy and exposes the reason",
    async (policy) => {
      const snapshot = structuredClone(capabilitySnapshot);
      const plugin = snapshot.plugins[0]!;
      if (policy === "parent") plugin.pluginEnabled = false;
      if (policy === "global") plugin.blockedByGlobalPolicy = true;
      plugin.capabilities[0] = {
        ...plugin.capabilities[0]!,
        enabled: false,
        blockedByPolicy: true,
        blockedReason: `Blocked by ${policy} policy.`,
      };
      const harness = pluginCapabilityHarness({ snapshot });
      await harness.manager.load();
      expect(harness.capabilityControl("read_file").disabled).toBe(true);
      expect(harness.root.innerHTML).toContain(`Blocked by ${policy} policy.`);
      expect(harness.root.innerHTML).toContain(
        'aria-describedby="plugin-tool-policy-filesystem-read_file"',
      );
      expect(
        await harness.manager.toggleCapability("filesystem", "read_file", true),
      ).toBe(false);
      expect(harness.dependencies.setPlugin).not.toHaveBeenCalled();
    },
  );

  test("rejects a duplicate child save and keeps the same open tool group after failure", async () => {
    let reject!: (error: Error) => void;
    const setPlugin = vi.fn(
      () =>
        new Promise<typeof capabilitySnapshot>((_resolve, no) => {
          reject = no;
        }),
    );
    const harness = pluginCapabilityHarness({ setPlugin });
    await harness.manager.load();
    harness.openTools();
    harness.toolsList().scrollTop = 140;
    const changing = harness.changeCapability("read_file", false);
    expect(harness.toolsList().scrollTop).toBe(140);
    expect(
      await harness.manager.toggleCapability("filesystem", "write_file", false),
    ).toBe(false);
    reject(new Error("Configuration file is read-only."));
    await changing;
    expect(setPlugin).toHaveBeenCalledOnce();
    expect(harness.toolsPanel().hidden).toBe(false);
    expect(harness.capabilityControl("read_file").checked).toBe(true);
    expect(harness.dependencies.onConfigurationSaved).not.toHaveBeenCalled();
    expect(harness.root.innerHTML).toContain('role="alert"');
  });

  test("keeps a successfully saved child pending when canonical refresh fails", async () => {
    const harness = pluginCapabilityHarness({
      refresh: async () => {
        throw new Error("Reload unavailable");
      },
    });
    await harness.manager.load();
    harness.openTools();
    await harness.changeCapability("read_file", false);
    expect(harness.capabilityControl("read_file").checked).toBe(false);
    expect(harness.dependencies.onConfigurationSaved).toHaveBeenCalledOnce();
    expect(harness.root.innerHTML).toContain(
      "Plugin selection saved; configuration refresh failed",
    );
  });

  test("escapes full descriptions and policy text while labeling individual switches", () => {
    const snapshot = structuredClone(capabilitySnapshot);
    snapshot.plugins[0]!.capabilities[0] = {
      id: "read_file",
      description: '<img src=x onerror="bad()">',
      enabled: false,
      blockedByPolicy: true,
      blockedReason: "Parent <disabled>",
    };
    const html = renderPluginManager({
      snapshot,
      busy: false,
      message: "",
      error: "",
      openPluginIds: new Set(["filesystem"]),
    });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="read_file in filesystem"');
    expect(html).toContain(
      'class="plugin-capability-description" title="&lt;img',
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("Parent &lt;disabled&gt;");
  });
  test("opens tools inside the same card and returns focus with Back or Escape", async () => {
    const harness = pluginCapabilityHarness();
    await harness.manager.load();
    expect(harness.toolsPanel().hidden).toBe(true);
    expect(harness.front().inert).toBe(false);
    harness.openTools();
    expect(harness.toolsPanel().hidden).toBe(false);
    expect(harness.front().inert).toBe(true);
    expect(harness.document.activeElement).toBe(harness.back());
    harness.opener().focus();
    expect(harness.document.activeElement).toBe(harness.back());
    harness.toolsList().scrollTop = 120;
    harness.closeTools();
    expect(harness.toolsPanel().hidden).toBe(true);
    expect(harness.front().inert).toBe(false);
    expect(harness.document.activeElement).toBe(harness.opener());
    harness.openTools();
    expect(harness.toolsList().scrollTop).toBe(120);
    const event = harness.escapeTools();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(harness.document.activeElement).toBe(harness.opener());
    expect(harness.toolsPanel().hidden).toBe(true);
    expect(harness.dependencies.setPlugin).not.toHaveBeenCalled();
  });

});
