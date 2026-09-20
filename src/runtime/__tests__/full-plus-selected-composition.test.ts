import { afterEach, describe, expect, test } from "vitest";
import {
  createDefaultSkillProvider,
  createDefaultToolRegistry,
} from "../default-adapters.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { loadRuntimeCapabilityPlugins } from "../plugins/runtime-capability-plugins.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";

afterEach(removePluginSelectionFixtures);
const modes = ["ask", "full_access", "full_plus"] as const;
const systemTools = [
  "system_applications",
  "system_command",
  "system_launch",
  "system_targets",
];

describe("permission mode only narrows the selected plugin catalog", () => {
  test.each([{ enabled: false }, { allow: ["*"], deny: ["*"] }])(
    "a globally disabled catalog stays empty in every mode: %j",
    async (selection) => {
      const config = await createPluginSelectionFixture(selection);
      const source = createDefaultToolRegistry(config);
      for (const mode of modes) {
        const registry = restrictToolRegistryToRequestMode(source, mode);
        expect(registry.hasToolsAvailable()).toBe(false);
        expect(registry.listDefinitions()).toEqual([]);
        expect(registry.listNormalInvocations?.()).toEqual([]);
        expect(registry.getImplementations()).toEqual({});
        const skills = createDefaultSkillProvider(config, {
          toolRegistry: registry,
        });
        for (const tool of ["exec", ...systemTools, "fixture_ping"]) {
          await expect(skills.getActionContext(tool)).resolves.toBe("");
          await expect(
            registry.execute({ tool, params: {} }),
          ).resolves.toMatchObject({ ok: false });
        }
      }
    },
  );

  test.each([
    { denied: "exec", unavailable: ["exec"] },
    { denied: "system", unavailable: systemTools },
    { denied: "system.system_command", unavailable: ["system_command"] },
  ])(
    "disabling $denied removes only supplied capabilities in every mode",
    async ({ denied, unavailable }) => {
      const config = await createPluginSelectionFixture({
        allow: ["*"],
        deny: [denied],
      });
      const source = createDefaultToolRegistry(config);
      for (const mode of modes) {
        const registry = restrictToolRegistryToRequestMode(source, mode);
        const skills = createDefaultSkillProvider(config, {
          toolRegistry: registry,
        });
        const registrationNames = registry
          .listNormalInvocations?.()
          .map(({ toolName }) => toolName);
        for (const tool of unavailable) {
          expect(registry.getDefinition(tool)).toBeUndefined();
          expect(registry.getImplementations()).not.toHaveProperty(tool);
          expect(registrationNames).not.toContain(tool);
          await expect(skills.getActionContext(tool)).resolves.toBe("");
          await expect(
            registry.execute({ tool, params: {} }),
          ).resolves.toMatchObject({ ok: false });
        }
        expect(registry.getDefinition("fixture_ping")).toBeDefined();
        await expect(skills.getActionContext("fixture_ping")).resolves.not.toBe(
          "",
        );
        await expect(
          registry.execute({ tool: "fixture_ping", params: {} }),
        ).resolves.toMatchObject({ ok: true, output: "fixture:1" });
      }
      const fullPlus = restrictToolRegistryToRequestMode(source, "full_plus");
      if (denied === "exec")
        expect(fullPlus.getDefinition("system_command")).toBeDefined();
      if (denied === "system.system_command")
        expect(fullPlus.getDefinition("system_targets")).toBeDefined();
      if (denied === "system")
        expect(fullPlus.getDefinition("exec")).toBeDefined();
    },
  );

  test.each([{ allow: ["fixture-active"] }, { allow: ["fixture_ping"] }])(
    "an allowlist does not gain implicit system capabilities: %j",
    async (selection) => {
      const config = await createPluginSelectionFixture(selection);
      const registry = restrictToolRegistryToRequestMode(
        createDefaultToolRegistry(config),
        "full_plus",
      );
      expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
        "fixture_ping",
      ]);
      await expect(
        registry.execute({ tool: "fixture_ping", params: {} }),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  test("default selection supplies approval-gated system capabilities in every mode", async () => {
    const config = await createPluginSelectionFixture();
    delete config.plugins;
    const catalog = loadRuntimeCapabilityPlugins(config);
    expect(loadRuntimeCapabilityPlugins(config)).toBe(catalog);
    expect(catalog.filter(({ id }) => id === "system")).toHaveLength(1);
    const source = createDefaultToolRegistry(config);
    const fullPlus = restrictToolRegistryToRequestMode(source, "full_plus");
    for (const mode of modes) {
      const selected = restrictToolRegistryToRequestMode(source, mode);
      for (const tool of systemTools) {
        expect(selected.getDefinition(tool)).toBeDefined();
        expect(
          selected.getDefinition(tool)?.requiredPermissionMode,
        ).toBeUndefined();
        expect(
          selected
            .listNormalInvocations?.()
            .find(({ toolName }) => toolName === tool)
            ?.contract.operations.every(
              ({ approval }) => approval === "always",
            ),
        ).toBe(true);
      }
    }
    const skills = createDefaultSkillProvider(config, {
      toolRegistry: fullPlus,
    });
    await expect(skills.getActionContext("system_command")).resolves.not.toBe(
      "",
    );
    await expect(
      fullPlus.execute({ tool: "fixture_ping", params: {} }),
    ).resolves.toMatchObject({ ok: true, output: "fixture:1" });
  });
});
