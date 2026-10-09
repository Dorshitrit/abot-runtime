import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { pluginLoadConfiguration } from "../plugins/configuration-context.js";
import {
  configurationRequest,
  pluginConfigurationFixture,
} from "./support/plugin-configuration-fixture.js";

test.each([
  [3, "old value"],
  ["new default", 7],
  [false, "true"],
  [{}, []],
  [[], {}],
])(
  "retained setting %j rejects an incompatible saved type",
  (fallback, value) => {
    expect(() =>
      pluginLoadConfiguration(
        "example",
        { settings: { defaults: { setting: fallback } } },
        { settings: { setting: value }, secrets: {} },
      ),
    ).toThrow("does not match its current default type");
  },
);

test("null defaults accept JSON values and undeclared settings remain unavailable", () => {
  expect(
    pluginLoadConfiguration(
      "example",
      { settings: { defaults: { setting: null } } },
      { settings: { setting: { custom: true }, removed: "old" }, secrets: {} },
    ).config,
  ).toEqual({ setting: { custom: true } });
});

test("changed manifest types block fresh owners while keeping the form available for repair", async () => {
  const f = await pluginConfigurationFixture();
  await f.save(
    { query: "previous query" },
    { token: { action: "set", value: "test-token" } },
  );
  const initial = loadConfiguredRuntimePlugins(f.config);
  const path = join(f.pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.extensions["ai.abot.runtime"].settings.defaults.query = 12;
  await writeFile(path, JSON.stringify(manifest));

  expect(() => loadConfiguredRuntimePlugins({ ...f.config })).toThrow(
    "Saved setting query for plugin community-example does not match",
  );
  expect((await configurationRequest(f.routes, "GET")).status).toBe(200);
  expect(f.view().settings.query).toBe("previous query");
  expect(loadConfiguredRuntimePlugins(f.config)).toBe(initial);

  await f.save({ query: 24 });
  const replacement = loadConfiguredRuntimePlugins({ ...f.config });
  expect(
    await replacement[0]!.capabilities[0]!.execute({} as never),
  ).toMatchObject({
    output: expect.stringContaining('"query":24'),
  });
  expect(await initial[0]!.capabilities[0]!.execute({} as never)).toMatchObject(
    {
      output: expect.stringContaining('"query":"previous query"'),
    },
  );
});
