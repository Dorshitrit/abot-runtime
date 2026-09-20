import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createPluginManager } from "../../web-ui/app/components/plugins/manager.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderPluginManager } from "../../web-ui/app/components/plugins/rendering.js";

const snapshot = {
  selection: { enabled: true, allow: ["*"], deny: [] },
  plugins: [
    {
      id: "example",
      description: "<script>bad</script>",
      capabilityCount: 2,
      selectedCapabilityCount: 1,
      state: "partial",
      blockedByGlobalPolicy: false,
    },
  ],
  application: "restart_required",
};

function harness(overrides: Record<string, unknown> = {}) {
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const dependencies = {
    loadPlugins: vi.fn(async () => snapshot),
    setPlugin: vi.fn(async () => snapshot),
    beginRuntimeMutation: vi.fn(() => true),
    refreshRuntimeConfig: vi.fn(async () => true),
    endRuntimeMutation: vi.fn(),
    onConfigurationSaved: vi.fn(),
    recordControlEvent: vi.fn(),
    ...overrides,
  };
  const manager = createPluginManager(dependencies);
  manager.mount(root);
  return { manager, dependencies, root };
}

describe("plugin management UI", () => {
  test("shows partial saved selection and escapes manifest content", () => {
    const html = renderPluginManager({
      snapshot,
      busy: false,
      message: "",
      error: "",
    });
    expect(html).toContain('data-plugin-state="partial"');
    expect(html).toContain("1 of 2 capabilities selected");
    expect(html).toContain('data-plugin-enabled="false"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("saved configuration");
  });

  test("blocks controls under global policy", () => {
    const blocked = {
      ...snapshot,
      selection: { enabled: false },
      plugins: snapshot.plugins.map((plugin) => ({
        ...plugin,
        selectedCapabilityCount: 0,
        state: "disabled",
        blockedByGlobalPolicy: true,
      })),
    };
    const html = renderPluginManager({
      snapshot: blocked,
      busy: false,
      message: "",
      error: "",
    });
    expect(html).toContain("Plugins are disabled globally");
    expect(html).toMatch(/aria-label="Enable example"\s+disabled/u);
  });

  test("an unsaved-configuration guard prevents the mutation", async () => {
    const guard = vi.fn(() => false);
    const { manager, dependencies } = harness({ beginRuntimeMutation: guard });
    await manager.load();
    expect(await manager.toggle("example", false)).toBe(false);
    expect(dependencies.setPlugin).not.toHaveBeenCalled();
    expect(dependencies.onConfigurationSaved).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledWith("plugin settings");
  });

  test("save marks application pending only after persistence and refreshes config", async () => {
    const { manager, dependencies, root } = harness();
    await manager.load();
    expect(await manager.toggle("example", false)).toBe(true);
    expect(dependencies.setPlugin).toHaveBeenCalledWith({
      pluginId: "example",
      enabled: false,
    });
    expect(dependencies.onConfigurationSaved).toHaveBeenCalledOnce();
    expect(dependencies.refreshRuntimeConfig).toHaveBeenCalledOnce();
    expect(dependencies.endRuntimeMutation).toHaveBeenCalledOnce();
    expect(root.innerHTML).toContain("Apply changes or restart Runtime");
  });

  test("failed save preserves pending state and unlocks controls", async () => {
    const { manager, dependencies, root } = harness({
      setPlugin: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    await manager.load();
    expect(await manager.toggle("example", false)).toBe(false);
    expect(dependencies.onConfigurationSaved).not.toHaveBeenCalled();
    expect(dependencies.endRuntimeMutation).toHaveBeenCalledOnce();
    expect(root.innerHTML).toContain('role="alert"');
    expect(root.innerHTML).toContain("write failed");
  });

  test("successful application replaces the pending status", async () => {
    const { manager, root } = harness();
    await manager.load();
    await manager.toggle("example", false);
    manager.markApplied();
    expect(root.innerHTML).toContain(
      "Plugin selection applied to this environment.",
    );
    expect(root.innerHTML).not.toContain("Plugin selection saved.");
  });

  test("a stale mutation response cannot change feedback or refresh another environment", async () => {
    let environmentId = "first";
    let resolveSave!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveSave = resolve;
    });
    const { manager, dependencies, root } = harness({
      getEnvironmentId: () => environmentId,
      setPlugin: vi.fn(() => pending),
    });
    await manager.load();
    const changing = manager.toggle("example", false);
    environmentId = "second";
    await manager.load();
    resolveSave(snapshot);
    expect(await changing).toBe(false);
    expect(dependencies.onConfigurationSaved).not.toHaveBeenCalled();
    expect(dependencies.refreshRuntimeConfig).not.toHaveBeenCalled();
    expect(dependencies.endRuntimeMutation).toHaveBeenCalledOnce();
    expect(root.innerHTML).not.toContain("Plugin selection saved.");
  });
});
