import { describe, expect, test, vi } from "vitest";
import {
  capabilitySnapshot,
  pluginCapabilityHarness,
} from "./support/plugin-capability-ui-harness.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderPluginPlatformNotice } from "../../web-ui/app/components/plugins/compatibility.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderModelPluginPermissions } from "../../web-ui/app/components/config-workspace/model-plugin-permissions.js";
// prettier-ignore
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { projectModelPluginSelection, setModelCapabilityEnabled } from "../../web-ui/app/components/config-workspace/model-plugin-selection.js";

function incompatibleSnapshot() {
  const snapshot = structuredClone(capabilitySnapshot);
  return {
    ...snapshot,
    plugins: snapshot.plugins.map((plugin) => ({
      ...plugin,
      compatibility: {
        supported: false,
        status: "unsupported",
        runtimePlatform: "win32",
        runtimePlatforms: ["linux"],
        reason:
          "This plugin supports Linux Runtime; this Runtime runs on Windows.",
      },
    })),
  };
}

describe("plugin host compatibility presentation", () => {
  test("escapes blocked host metadata and does not claim availability from support alone", () => {
    const notice = renderPluginPlatformNotice({
      supported: false,
      runtimePlatform: '\"><img src=x>',
      reason: "<script>bad()</script>",
    });
    expect(notice).toContain("&lt;script&gt;");
    expect(notice).not.toContain("<script>");
    expect(notice).not.toContain("<img");
    expect(
      renderPluginPlatformNotice({ supported: true, status: "declared" }),
    ).toBe("");
    expect(
      renderPluginPlatformNotice({ supported: true, status: "legacy" }),
    ).toBe("");
    expect(renderPluginPlatformNotice(undefined)).toBe("");
  });

  test("shows the host limitation in installed cards and tools while preserving editable selection", async () => {
    const harness = pluginCapabilityHarness({
      snapshot: incompatibleSnapshot(),
    });
    await harness.manager.load();
    expect(
      harness.root.innerHTML.match(/data-plugin-platform="win32"/gu),
    ).toHaveLength(2);
    expect(harness.snapshot.plugins[0]!.pluginEnabled).toBe(true);
    harness.openTools();
    expect(harness.capabilityControl("read_file").checked).toBe(true);
    expect(harness.capabilityControl("read_file").disabled).toBe(false);
    await harness.changeCapability("read_file", false);
    expect(harness.dependencies.setPlugin).toHaveBeenCalledExactlyOnceWith({
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: false,
    });
    expect(harness.capabilityControl("write_file").checked).toBe(true);
  });

  test("shows compatibility in onboarding and still saves the requested selection", async () => {
    const snapshot = incompatibleSnapshot();
    const setPlugin = vi.fn(async () => snapshot);
    const harness = createGuideHarness({
      loadSetup: async () => ({
        setup: {
          ...setupSnapshot,
          status: "ready",
          existingModel: { provider: "ollama", model: "chat-model" },
        },
      }),
      loadPlugins: async () => snapshot,
      setPlugin,
    });
    await harness.open();
    harness.click("skip-embedding");
    await harness.ready();
    expect(harness.container.innerHTML).toContain(
      'data-plugin-platform="win32"',
    );
    const input = harness.container
      .querySelectorAll("[data-runtime-plugin-toggle]")
      .find((entry) => entry.dataset.runtimeCapability === "read_file")!;
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
    input.checked = false;
    input.dispatch("change");
    await harness.ready();
    expect(setPlugin).toHaveBeenCalledExactlyOnceWith({
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: false,
    });
  });

  test("retains model selection and renders the host restriction without a new permission rule", () => {
    const catalog = incompatibleSnapshot();
    const config = { plugins: { deny: [] as string[] } };
    const plugin = catalog.plugins[0]!;
    const projected = projectModelPluginSelection(
      config,
      plugin,
      catalog.plugins,
    );
    expect(projected.pluginEnabled).toBe(true);
    expect(projected.selectedCapabilityCount).toBe(2);
    expect(projected.controlBlockedReason).toBe("");
    expect(projected.compatibility).toEqual(plugin.compatibility);
    const markup = renderModelPluginPermissions(
      { id: "model", config },
      catalog,
    );
    expect(markup).toMatch(
      /<summary[^>]*>[\s\S]*class="model-plugin-platform-note"[\s\S]*<\/summary>/u,
    );
    expect(markup).toContain('data-plugin-platform="win32"');
    const controls = [...markup.matchAll(/<input[^>]*>/gu)].map(
      ([input]) => input,
    );
    expect(controls).toHaveLength(3);
    expect(
      controls.every(
        (input) => input.includes("checked") && !input.includes("disabled"),
      ),
    ).toBe(true);
    expect(
      setModelCapabilityEnabled(
        config,
        catalog.plugins,
        "filesystem",
        "read_file",
        false,
      ),
    ).toBe(true);
    expect(config.plugins.deny).toEqual(["filesystem.read_file"]);
  });
});
