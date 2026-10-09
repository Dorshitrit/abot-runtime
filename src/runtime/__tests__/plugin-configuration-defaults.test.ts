import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { readPluginConfigurationStore } from "../plugins/configuration-store.js";
import { pluginConfigurationFixture } from "./support/plugin-configuration-fixture.js";
// @ts-expect-error Browser module.
import { readPluginConfigurationFields } from "../../web-ui/app/components/plugins/configuration-fields.js";

async function upgradeDefaults(
  f: Awaited<ReturnType<typeof pluginConfigurationFixture>>,
) {
  const path = join(f.pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  Object.assign(manifest.extensions["ai.abot.runtime"].settings.defaults, {
    limit: 8,
    query: "new default query",
  });
  await writeFile(path, JSON.stringify(manifest));
}

test("secret-only form saves preserve inheritance across a manifest upgrade", async () => {
  const f = await pluginConfigurationFixture();
  const root = {
    querySelector: (selector: string) => {
      if (selector === '[data-plugin-secret-action="0"]')
        return { value: "set" };
      if (selector === '[data-plugin-secret-value="0"]')
        return { value: "default-test-secret" };
      return null;
    },
  };
  const input = readPluginConfigurationFields(root, f.view());
  expect(input.settings).toEqual({});
  await f.save(input.settings, input.secrets);
  expect(
    readPluginConfigurationStore(f.rootDir).plugins["community-example"]!
      .settings,
  ).toEqual({});
  await upgradeDefaults(f);
  expect(f.view().settings).toMatchObject({
    limit: 8,
    query: "new default query",
  });
  expect(f.view().settingOverrides).toEqual([]);
  const loaded = loadConfiguredRuntimePlugins(f.config);
  expect(await loaded[0]!.capabilities[0]!.execute({} as never)).toMatchObject({
    output: expect.stringContaining('"limit":8'),
  });
});

test("an explicit value equal to the old default stays local until explicitly reset", async () => {
  const f = await pluginConfigurationFixture();
  await f.save({ limit: 3, query: "custom" });
  expect(f.view().settingOverrides).toEqual(["query", "limit"]);
  const unchanged = readPluginConfigurationFields(null, f.view());
  expect(unchanged.settings).toEqual({ limit: 3, query: "custom" });
  await f.save(unchanged.settings);
  await upgradeDefaults(f);
  expect(f.view().settings).toMatchObject({ limit: 3, query: "custom" });
  const resetRoot = {
    querySelector: (selector: string) =>
      selector === '[data-plugin-setting="2"]'
        ? { dataset: { pluginSettingOverridden: "false" }, value: "8" }
        : null,
  };
  const reset = readPluginConfigurationFields(resetRoot, f.view());
  expect(reset.settings).toEqual({ query: "custom" });
  await f.save(reset.settings);
  expect(f.view().settings.limit).toBe(8);
  expect(f.view().settingOverrides).toEqual(["query"]);
});

test("existing stores with every default saved remain explicit without automatic migration", async () => {
  const f = await pluginConfigurationFixture();
  const defaults = f.view().defaults;
  await f.save(defaults);
  await upgradeDefaults(f);
  const input = readPluginConfigurationFields(null, f.view());
  expect(input.settings).toEqual(defaults);
  await f.save(input.settings, {
    optional: { action: "set", value: "test-only" },
  });
  expect(
    readPluginConfigurationStore(f.rootDir).plugins["community-example"]!
      .settings,
  ).toEqual(defaults);
});
