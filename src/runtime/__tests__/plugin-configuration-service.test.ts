import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { PluginManagementRoutes } from "../../web-ui/local-runtime/plugin-management-routes.js";
import { PluginManagementError } from "../../web-ui/plugin-management-service.js";
import { saveRuntimePluginConfiguration } from "../../web-ui/plugin-configuration-service.js";
import {
  pluginConfigurationPath,
  readPluginConfigurationStore,
} from "../plugins/configuration-store.js";
import {
  configurationRequest,
  pluginConfigurationFixture,
} from "./support/plugin-configuration-fixture.js";

test("GET and SET project settings and credential presence without exposing passwords or changing the manifest/env", async () => {
  const f = await pluginConfigurationFixture();
  vi.stubEnv("ABOT_CONFIGURATION_TEST_TOKEN", "inherited-private-token");
  const manifestBefore = await readFile(
    join(f.pluginRoot, "plugin.json"),
    "utf8",
  );
  const result = await configurationRequest(f.routes, "PUT", {
    revision: f.view().revision,
    settings: { query: "my query", limit: 7 },
    secrets: { token: { action: "set", value: "saved-private-token" } },
  });
  expect(result.status).toBe(200);
  expect(result.payload.configuration.settings).toMatchObject({
    query: "my query",
    limit: 7,
    url: "https://example.test",
  });
  expect(result.payload.configuration.secrets[0]).toMatchObject({
    configured: true,
    locallyConfigured: true,
  });
  const get = await configurationRequest(f.routes, "GET");
  expect(get.headers["Cache-Control"]).toBe("no-store");
  expect(JSON.stringify([result.payload, get.payload])).not.toMatch(
    /saved-private-token|inherited-private-token/,
  );
  expect(process.env.ABOT_CONFIGURATION_TEST_TOKEN).toBe(
    "inherited-private-token",
  );
  expect(await readFile(join(f.pluginRoot, "plugin.json"), "utf8")).toBe(
    manifestBefore,
  );
  expect((await lstat(pluginConfigurationPath(f.rootDir))).mode & 0o777).toBe(
    0o600,
  );
});

test("omitted credentials preserve values; explicit clear masks an inherited credential for only this plugin", async () => {
  const f = await pluginConfigurationFixture();
  vi.stubEnv("ABOT_CONFIGURATION_TEST_TOKEN", "inherited");
  await f.save({}, { token: { action: "set", value: "replacement" } });
  await f.save({ query: "changed" });
  expect(
    readPluginConfigurationStore(f.rootDir).plugins["community-example"].secrets
      .token.value,
  ).toBe("replacement");
  await f.save({}, { token: { action: "clear" } });
  expect(f.view().secrets[0].configured).toBe(false);
  expect(process.env.ABOT_CONFIGURATION_TEST_TOKEN).toBe("inherited");
});

test.each([
  { settings: { unknown: "value" } },
  { settings: { limit: "seven" } },
  { settings: { options: [] } },
  { secrets: { unknown: { action: "set", value: "secret" } } },
  { secrets: { token: { action: "set", value: "" } } },
  { secrets: { token: { action: "clear", value: "secret" } } },
])(
  "invalid submitted configuration is rejected before storage: %j",
  async (changes) => {
    const f = await pluginConfigurationFixture();
    const result = await configurationRequest(f.routes, "PUT", {
      revision: f.view().revision,
      settings: {},
      ...changes,
    });
    expect(result.status).toBe(400);
    expect(readPluginConfigurationStore(f.rootDir).raw).toBeUndefined();
  },
);

test("concurrent forms and changed manifest declarations require a fresh read", async () => {
  const f = await pluginConfigurationFixture();
  const revision = f.view().revision;
  await f.save({ query: "first" });
  expect(
    (
      await configurationRequest(f.routes, "PUT", {
        revision,
        settings: { query: "stale" },
      })
    ).status,
  ).toBe(409);
  const nextRevision = f.view().revision;
  const path = join(f.pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.extensions["ai.abot.runtime"].settings.defaults.limit = 5;
  await writeFile(path, JSON.stringify(manifest));
  expect(
    (
      await configurationRequest(f.routes, "PUT", {
        revision: nextRevision,
        settings: {},
      })
    ).status,
  ).toBe(409);
  expect(f.view().settings.query).toBe("first");
});

test("cross-origin and busy mutations do not write", async () => {
  const f = await pluginConfigurationFixture();
  const input = { revision: f.view().revision, settings: {} };
  expect(
    (
      await configurationRequest(f.routes, "PUT", input, undefined, {
        origin: "https://abot-ai.com",
      })
    ).status,
  ).toBe(403);
  const routes = new PluginManagementRoutes({
    ...f,
    requireMutationIdle: () => {
      throw new PluginManagementError("plugin_runtime_busy", "busy", 409);
    },
  });
  expect((await configurationRequest(routes, "PUT", input)).status).toBe(409);
  expect(readPluginConfigurationStore(f.rootDir).raw).toBeUndefined();
});

test("a failed related commit restores the exact private configuration", async () => {
  const f = await pluginConfigurationFixture();
  await f.save(
    { query: "before" },
    { token: { action: "set", value: "previous" } },
  );
  const before = readPluginConfigurationStore(f.rootDir).raw;
  await expect(
    saveRuntimePluginConfiguration(f, {
      pluginId: "community-example",
      input: {
        revision: f.view().revision,
        settings: { query: "after" },
        secrets: { token: { action: "set", value: "next" } },
      },
      commit: async () => {
        throw new Error("selection rejected");
      },
    }),
  ).rejects.toThrow("selection rejected");
  expect(readPluginConfigurationStore(f.rootDir).raw).toBe(before);
});

test("unsafe or malformed stores fail closed without reflecting their contents", async () => {
  const f = await pluginConfigurationFixture();
  await f.save({});
  await writeFile(pluginConfigurationPath(f.rootDir), "{private-parse-content");
  const response = await configurationRequest(f.routes, "GET");
  expect(response.status).toBe(409);
  expect(JSON.stringify(response.payload)).not.toContain(
    "private-parse-content",
  );
  const other = await pluginConfigurationFixture();
  const outside = join(other.rootDir, "outside.json");
  await writeFile(outside, "private-file");
  await other.save({});
  const { rm } = await import("node:fs/promises");
  await rm(pluginConfigurationPath(other.rootDir));
  await symlink(outside, pluginConfigurationPath(other.rootDir));
  expect((await configurationRequest(other.routes, "GET")).status).toBe(409);
  expect(await readFile(outside, "utf8")).toBe("private-file");
});
