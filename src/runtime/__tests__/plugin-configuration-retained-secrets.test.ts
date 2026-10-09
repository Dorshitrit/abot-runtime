import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { readPluginConfigurationStore } from "../plugins/configuration-store.js";
import {
  configurationRequest,
  pluginConfigurationFixture,
} from "./support/plugin-configuration-fixture.js";

async function removedSecretFixture() {
  const f = await pluginConfigurationFixture();
  await f.save(
    {},
    {
      token: { action: "set", value: "current-private-key" },
      optional: { action: "set", value: "unused-private-key" },
    },
  );
  const path = join(f.pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  delete manifest.extensions["ai.abot.runtime"].secrets.optional;
  await writeFile(path, JSON.stringify(manifest));
  return { ...f, manifest, manifestPath: path };
}

test("unused keys stay visible without values and survive unrelated saves until explicitly deleted", async () => {
  const f = await removedSecretFixture();
  vi.stubEnv("ABOT_CONFIGURATION_OPTIONAL_TOKEN", "inherited-optional");
  const get = await configurationRequest(f.routes, "GET");
  expect(get.payload.configuration.retainedSecrets).toEqual([
    {
      name: "optional",
      env: "ABOT_CONFIGURATION_OPTIONAL_TOKEN",
      configured: true,
    },
  ]);
  expect(JSON.stringify(get.payload)).not.toMatch(
    /current-private-key|unused-private-key/,
  );
  await f.save({ query: "edited" });
  const before = readPluginConfigurationStore(f.rootDir);
  expect(before.plugins["community-example"]!.secrets.optional!.value).toBe(
    "unused-private-key",
  );
  const cleared = await configurationRequest(f.routes, "PUT", {
    revision: f.view().revision,
    settings: { query: "edited" },
    clearRetainedSecrets: [
      { name: "optional", env: "ABOT_CONFIGURATION_OPTIONAL_TOKEN" },
    ],
  });
  expect(cleared.status).toBe(200);
  expect(cleared.payload.configuration.retainedSecrets).toEqual([]);
  const after = readPluginConfigurationStore(f.rootDir).plugins[
    "community-example"
  ]!;
  expect(after.secrets).not.toHaveProperty("optional");
  expect(after.secrets.token!.value).toBe("current-private-key");
  expect(process.env.ABOT_CONFIGURATION_OPTIONAL_TOKEN).toBe(
    "inherited-optional",
  );
});

test("Configure remains available when an upgrade removes every configuration declaration", async () => {
  const f = await removedSecretFixture();
  delete f.manifest.extensions["ai.abot.runtime"].secrets;
  delete f.manifest.extensions["ai.abot.runtime"].settings;
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const catalog = await configurationRequest(
    f.routes,
    "GET",
    null,
    "runtime/plugins",
  );
  expect(
    catalog.payload.plugins.find(
      (p: { id: string }) => p.id === "community-example",
    ).configurable,
  ).toBe(true);
  expect(f.view().secrets).toEqual([]);
  expect(f.view().retainedSecrets).toHaveLength(2);
  const cleared = await configurationRequest(f.routes, "PUT", {
    revision: f.view().revision,
    settings: {},
    clearRetainedSecrets: f
      .view()
      .retainedSecrets.map(({ name, env }) => ({ name, env })),
  });
  expect(cleared.status).toBe(200);
  const next = await configurationRequest(
    f.routes,
    "GET",
    null,
    "runtime/plugins",
  );
  expect(
    next.payload.plugins.find(
      (p: { id: string }) => p.id === "community-example",
    ).configurable,
  ).toBe(false);
});

test.each(["set", "clear"])(
  "changed environment bindings keep old values until explicit deletion before %s",
  async (action) => {
    const f = await pluginConfigurationFixture();
    await f.save(
      {},
      { token: { action: "set", value: "old-binding-private" } },
    );
    const path = join(f.pluginRoot, "plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.extensions["ai.abot.runtime"].secrets.token.env = "ABOT_NEW_TOKEN";
    await writeFile(path, JSON.stringify(manifest));
    await f.save({ query: "keep old key" });
    const before = readPluginConfigurationStore(f.rootDir).raw;
    const input = {
      revision: f.view().revision,
      settings: {},
      secrets: {
        token:
          action === "set"
            ? { action, value: "new-binding-private" }
            : { action },
      },
    };
    const rejected = await configurationRequest(f.routes, "PUT", input);
    expect(rejected.status).toBe(400);
    expect(readPluginConfigurationStore(f.rootDir).raw).toBe(before);
    const accepted = await configurationRequest(f.routes, "PUT", {
      ...input,
      clearRetainedSecrets: [
        { name: "token", env: "ABOT_CONFIGURATION_TEST_TOKEN" },
      ],
    });
    expect(accepted.status).toBe(200);
    expect(
      readPluginConfigurationStore(f.rootDir).plugins["community-example"]!
        .secrets.token,
    ).toEqual({
      env: "ABOT_NEW_TOKEN",
      value: action === "set" ? "new-binding-private" : null,
    });
  },
);

test.each([
  [{ name: "token", env: "ABOT_CONFIGURATION_TEST_TOKEN" }],
  [{ name: "optional", env: "wrong-binding" }],
  [{ name: "unknown", env: "UNKNOWN" }],
  [
    {
      name: "optional",
      env: "ABOT_CONFIGURATION_OPTIONAL_TOKEN",
      value: "injected",
    },
  ],
  "all",
])(
  "unused-key deletion rejects invalid or current bindings: %j",
  async (clearRetainedSecrets) => {
    const f = await removedSecretFixture();
    const before = readPluginConfigurationStore(f.rootDir).raw;
    expect(
      (
        await configurationRequest(f.routes, "PUT", {
          revision: f.view().revision,
          settings: {},
          clearRetainedSecrets,
        })
      ).status,
    ).toBe(400);
    expect(readPluginConfigurationStore(f.rootDir).raw).toBe(before);
  },
);

test("stale unused-key deletion cannot erase a newer saved value", async () => {
  const f = await removedSecretFixture();
  const revision = f.view().revision;
  await f.save({ query: "newer form" });
  const before = readPluginConfigurationStore(f.rootDir).raw;
  expect(
    (
      await configurationRequest(f.routes, "PUT", {
        revision,
        settings: {},
        clearRetainedSecrets: [
          { name: "optional", env: "ABOT_CONFIGURATION_OPTIONAL_TOKEN" },
        ],
      })
    ).status,
  ).toBe(409);
  expect(readPluginConfigurationStore(f.rootDir).raw).toBe(before);
});
