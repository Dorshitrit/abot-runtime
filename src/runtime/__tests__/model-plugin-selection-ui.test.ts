import { describe, expect, test } from "vitest";
// prettier-ignore
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { modelPluginRulesNeedRepair, projectModelPluginSelection, setModelPluginEnabled, setModelCapabilityEnabled } from "../../web-ui/app/components/config-workspace/model-plugin-selection.js";

function plugin(id = "files", ids = ["read", "write"]) {
  return {
    id,
    pluginEnabled: true,
    state: "enabled",
    blockedByGlobalPolicy: false,
    selectedCapabilityCount: ids.length,
    capabilityCount: ids.length,
    capabilities: ids.map((capabilityId) => ({
      id: capabilityId,
      enabled: true,
      blockedByPolicy: false,
    })),
  };
}

function fixture() {
  const plugins = [plugin(), plugin("other", ["lookup"])];
  const original = structuredClone(plugins);
  return { plugins, original, selected: plugins[0]! };
}

describe("model plugin selection projection and scoped changes", () => {
  test("changes only one qualified tool selector and leaves siblings, unknown rules and catalog unchanged", () => {
    const f = fixture();
    const config = {
      plugins: { deny: [" unknown ", "other.lookup"], retained: "keep" },
      generation: { temperature: 0.2 },
    };
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "read", false),
    ).toBe(true);
    expect(config.plugins).toEqual({
      deny: [" unknown ", "other.lookup", "files.read"],
      retained: "keep",
    });
    const projected = projectModelPluginSelection(
      config,
      f.selected,
      f.plugins,
    );
    expect(projected).toMatchObject({
      pluginEnabled: true,
      state: "partial",
      selectedCapabilityCount: 1,
    });
    expect(projected.capabilities).toMatchObject([
      { id: "read", enabled: false, blockedReason: "" },
      { id: "write", enabled: true, blockedReason: "" },
    ]);
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "read", true),
    ).toBe(true);
    expect(config.plugins.deny).toEqual([" unknown ", "other.lookup"]);
    expect(config.generation).toEqual({ temperature: 0.2 });
    expect(f.plugins).toEqual(f.original);
  });

  test("a model parent block preserves children and requires explicit parent enable before changing one child", () => {
    const f = fixture();
    const config = { plugins: { deny: ["files.read", "unknown"] } };
    expect(setModelPluginEnabled(config, f.plugins, "files", false)).toBe(true);
    expect(config.plugins.deny).toEqual(["files.read", "unknown", "files"]);
    expect(
      projectModelPluginSelection(config, f.selected, f.plugins),
    ).toMatchObject({
      pluginEnabled: false,
      selectedCapabilityCount: 0,
      state: "disabled",
      capabilities: [
        { enabled: false, blockedReason: expect.any(String) },
        { enabled: false, blockedReason: expect.any(String) },
      ],
    });
    const blocked = structuredClone(config);
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "read", true),
    ).toBe(false);
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "write", false),
    ).toBe(false);
    expect(config).toEqual(blocked);
    expect(setModelPluginEnabled(config, f.plugins, "files", true)).toBe(true);
    expect(config.plugins.deny).toEqual(["files.read", "unknown"]);
    expect(
      projectModelPluginSelection(config, f.selected, f.plugins),
    ).toMatchObject({ pluginEnabled: true, selectedCapabilityCount: 1 });
  });

  test("all children can be off independently while their parent stays on", () => {
    const f = fixture();
    const config = { plugins: { deny: ["files.read", "files.write"] } };
    const projected = projectModelPluginSelection(
      config,
      f.selected,
      f.plugins,
    );
    expect(projected).toMatchObject({
      pluginEnabled: true,
      state: "disabled",
      selectedCapabilityCount: 0,
      controlBlockedReason: "",
    });
    expect(
      projected.capabilities.every(
        (capability: { blockedReason: string }) =>
          capability.blockedReason === "",
      ),
    ).toBe(true);
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "read", true),
    ).toBe(true);
    expect(config.plugins.deny).toEqual(["files.write"]);
    expect(
      projectModelPluginSelection(config, f.selected, f.plugins).state,
    ).toBe("partial");
  });

  test.each(["*", "read"])(
    "preserves broad saved rule %s when a child is toggled",
    (rule) => {
      const f = fixture();
      const config = { plugins: { deny: [rule, "files.read", "unknown"] } };
      const original = structuredClone(config);
      const projected = projectModelPluginSelection(
        config,
        f.selected,
        f.plugins,
      );
      expect(projected.capabilities[0].enabled).toBe(false);
      expect(projected.capabilities[0].blockedReason).not.toBe("");
      expect(
        setModelCapabilityEnabled(config, f.plugins, "files", "read", true),
      ).toBe(false);
      if (rule === "*") {
        expect(projected.pluginEnabled).toBe(false);
        expect(projected.controlBlockedReason).not.toBe("");
        expect(setModelPluginEnabled(config, f.plugins, "files", true)).toBe(
          false,
        );
      }
      expect(config).toEqual(original);
    },
  );

  test("combines partial global availability with model selection without enabling a globally unavailable child", () => {
    const f = fixture();
    f.selected.state = "partial";
    f.selected.capabilities[0]!.enabled = false;
    const config = {};
    const original = structuredClone(f.plugins);
    const projected = projectModelPluginSelection(
      config,
      f.selected,
      f.plugins,
    );
    expect(projected).toMatchObject({
      pluginEnabled: true,
      selectedCapabilityCount: 1,
      state: "partial",
      controlBlockedReason: "",
    });
    expect(projected.capabilities[0]).toMatchObject({
      enabled: false,
      blockedReason: expect.any(String),
    });
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "read", true),
    ).toBe(false);
    expect(config).toEqual({});
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "write", false),
    ).toBe(true);
    expect(config).toEqual({ plugins: { deny: ["files.write"] } });
    expect(f.plugins).toEqual(original);
  });

  test.each(["parent", "all-tools", "global"])(
    "blocks controls for global %s restriction but retains the local parent's configured state",
    (reason) => {
      const f = fixture();
      if (reason === "parent") f.selected.pluginEnabled = false;
      if (reason === "all-tools") {
        f.selected.state = "disabled";
        f.selected.capabilities.forEach((capability) => {
          capability.enabled = false;
        });
      }
      if (reason === "global") f.selected.blockedByGlobalPolicy = true;
      const config = {};
      const projected = projectModelPluginSelection(
        config,
        f.selected,
        f.plugins,
      );
      expect(projected.pluginEnabled).toBe(true);
      expect(projected.controlBlockedReason).not.toBe("");
      expect(projected.selectedCapabilityCount).toBe(0);
      expect(setModelPluginEnabled(config, f.plugins, "files", false)).toBe(
        false,
      );
      expect(
        setModelCapabilityEnabled(config, f.plugins, "files", "read", false),
      ).toBe(false);
      expect(config).toEqual({});
    },
  );

  test.each([null, "files", { deny: "read" }, { deny: [3] }])(
    "does not mutate malformed model plugin rules: %j",
    (plugins) => {
      const f = fixture();
      const config = { plugins };
      const original = structuredClone(config);
      expect(modelPluginRulesNeedRepair(config)).toBe(true);
      expect(setModelPluginEnabled(config, f.plugins, "files", false)).toBe(
        false,
      );
      expect(
        setModelCapabilityEnabled(config, f.plugins, "files", "read", false),
      ).toBe(false);
      expect(config).toEqual(original);
    },
  );

  test("preserves absent configuration and whitespace rules on no-op or invalid targets", () => {
    const f = fixture();
    const config = {};
    expect(setModelPluginEnabled(config, f.plugins, "files", true)).toBe(false);
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "read", true),
    ).toBe(false);
    expect(setModelPluginEnabled(config, f.plugins, "missing", false)).toBe(
      false,
    );
    expect(
      setModelCapabilityEnabled(config, f.plugins, "files", "missing", false),
    ).toBe(false);
    expect(config).toEqual({});
    const whitespace = {
      plugins: { deny: [" files.read ", "files.read", "unknown"] },
    };
    expect(
      setModelCapabilityEnabled(whitespace, f.plugins, "files", "read", false),
    ).toBe(false);
    expect(
      setModelCapabilityEnabled(whitespace, f.plugins, "files", "read", true),
    ).toBe(true);
    expect(whitespace.plugins.deny).toEqual(["unknown"]);
  });

  test("rejects a qualified selector aliasing another capability even when that capability is already denied", () => {
    const selected = plugin("files", ["read", "files.read"]);
    const plugins = [selected];
    const config = { plugins: { deny: ["files.files.read"] } };
    const original = structuredClone(config);
    const projected = projectModelPluginSelection(config, selected, plugins);
    expect(projected.capabilities[0]).toMatchObject({
      enabled: true,
      blockedReason: expect.any(String),
    });
    expect(
      setModelCapabilityEnabled(config, plugins, "files", "read", false),
    ).toBe(false);
    expect(config).toEqual(original);
  });

  test("rejects plugin and child selectors that affect another plugin", () => {
    const selected = plugin();
    const plugins = [selected, plugin("other", ["files", "files.read"])];
    const config = {};
    const projected = projectModelPluginSelection(config, selected, plugins);
    expect(projected.controlBlockedReason).not.toBe("");
    expect(projected.capabilities[0].blockedReason).not.toBe("");
    expect(setModelPluginEnabled(config, plugins, "files", false)).toBe(false);
    expect(
      setModelCapabilityEnabled(config, plugins, "files", "read", false),
    ).toBe(false);
    expect(
      setModelCapabilityEnabled(config, plugins, "files", "write", false),
    ).toBe(true);
    expect(config).toEqual({ plugins: { deny: ["files.write"] } });
  });
});
