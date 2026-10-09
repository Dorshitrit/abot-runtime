import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildPluginConfig } from "../config/builders.js";
import { RUNTIME_CONFIG_JSON_SCHEMA } from "../config.js";
import { validatePluginConfig } from "../config/validation/runtime-root-section-validation.js";
import {
  normalizePluginSelection,
  isPluginToolSelected,
} from "../plugins/selection.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { pluginSelectionEscapesRequestedScope } from "../../web-ui/plugin-management-selection.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";

afterEach(removePluginSelectionFixtures);

test("exact plugin disables survive configuration loading and schema validation", () => {
  const raw = { disabledPluginIds: [" a ", "a.x"] };
  const issues: string[] = [];
  validatePluginConfig(issues, raw);
  expect(issues).toEqual([]);
  expect(buildPluginConfig({ plugins: raw })).toEqual({
    disabledPluginIds: ["a", "a.x"],
  });
  expect(
    (RUNTIME_CONFIG_JSON_SCHEMA as any).properties.plugins.properties
      .disabledPluginIds,
  ).toMatchObject({ type: "array", items: { type: "string" } });
});

test.each(["a", [42], false])(
  "invalid exact-disable value is rejected: %j",
  (disabledPluginIds) => {
    const issues: string[] = [];
    validatePluginConfig(issues, { disabledPluginIds });
    expect(
      issues.some((issue) => issue.includes("plugins.disabledPluginIds")),
    ).toBe(true);
  },
);

test("exact IDs do not match tool names, composite names, prefixes or wildcards", () => {
  const selection = normalizePluginSelection({
    disabledPluginIds: [" a ", "a", "a.x", "*"],
  });
  expect(selection.disabledPluginIds).toEqual(["*", "a", "a.x"]);
  expect(Object.isFrozen(selection.disabledPluginIds)).toBe(true);
  expect(
    isPluginToolSelected({ pluginId: "a", toolName: "x", selection }),
  ).toBe(false);
  expect(
    isPluginToolSelected({ pluginId: "a.x", toolName: "y", selection }),
  ).toBe(false);
  expect(
    isPluginToolSelected({ pluginId: "a.xy", toolName: "z", selection }),
  ).toBe(true);
  expect(
    isPluginToolSelected({ pluginId: "b", toolName: "a", selection }),
  ).toBe(true);
  expect(
    isPluginToolSelected({ pluginId: "b", toolName: "a.x", selection }),
  ).toBe(true);
});

test("loaded catalog cache follows exact disables on the same configuration object", async () => {
  const config = await createPluginSelectionFixture({
    allow: ["fixture-active"],
  });
  const active = loadConfiguredRuntimePlugins(config);
  expect(active.map((plugin) => plugin.id)).toEqual(["fixture-active"]);
  config.plugins!.disabledPluginIds = ["fixture-active"];
  expect(loadConfiguredRuntimePlugins(config)).toEqual([]);
  config.plugins!.disabledPluginIds = [];
  expect(loadConfiguredRuntimePlugins(config)).toBe(active);
});

test("an exact disabled ID skips malformed metadata before discovery", async () => {
  const config = await createPluginSelectionFixture({
    allow: ["fixture-active"],
    disabledPluginIds: ["fixture-active"],
  });
  await writeFile(
    join(config.paths.rootDir, "plugins/fixture-active/plugin.json"),
    "{broken",
  );
  expect(loadConfiguredRuntimePlugins(config)).toEqual([]);
  config.plugins!.disabledPluginIds = [];
  expect(() => loadConfiguredRuntimePlugins(config)).toThrow(/manifest/);
});

test("scope checks cannot change another exact disable even for an absent package", () => {
  expect(
    pluginSelectionEscapesRequestedScope({
      manifests: [],
      pluginId: "a",
      before: { disabledPluginIds: ["absent"] },
      after: {},
    }),
  ).toBe(true);
  expect(
    pluginSelectionEscapesRequestedScope({
      manifests: [],
      pluginId: "a",
      capabilityId: "x",
      before: {},
      after: { disabledPluginIds: ["a"] },
    }),
  ).toBe(true);
});
