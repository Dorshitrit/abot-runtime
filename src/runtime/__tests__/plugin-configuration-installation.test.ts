// @ts-expect-error Browser module.
import { readPluginConfigurationFields } from "../../web-ui/app/components/plugins/configuration-fields.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { readPluginConfigurationStore } from "../plugins/configuration-store.js";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import {
  communityArchive,
  pluginSource,
} from "./support/plugin-installation-fixture.js";
import {
  configurableManifest,
  configurationCode,
  configurationRequest,
  pluginConfigurationFixture,
} from "./support/plugin-configuration-fixture.js";

async function installationFixture() {
  const f = await pluginConfigurationFixture(false);
  const archive = await communityArchive({
    manifest: configurableManifest(),
    code: configurationCode,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("codeload")
        ? new Response(new Uint8Array(archive))
        : new Response(JSON.stringify({ sha: pluginSource.ref })),
    ),
  );
  const inspect = () =>
    configurationRequest(
      f.routes,
      "POST",
      pluginSource,
      "runtime/plugins/inspect",
    );
  const install = (review: any, configuration?: Record<string, unknown>) =>
    configurationRequest(
      f.routes,
      "POST",
      {
        source: review.source,
        digest: review.digest,
        ...(configuration ? { configuration } : {}),
      },
      "runtime/plugins/install",
    );
  return { ...f, inspect, install };
}

test("Marketplace review, configured install, Remove and reinstall keep local values and never disclose keys", async () => {
  const f = await installationFixture();
  const first = await f.inspect();
  expect(first.status).toBe(200);
  expect(first.payload.review.configuration.settings.query).toBe(
    "default query",
  );
  const result = await f.install(first.payload.review, {
    revision: first.payload.review.configuration.revision,
    settings: { query: "community news" },
    secrets: { token: { action: "set", value: "private-install-key" } },
  });
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.payload)).not.toContain("private-install-key");
  const loaded = loadConfiguredRuntimePlugins({ ...f.config });
  expect(await loaded[0]!.capabilities[0]!.execute({} as never)).toMatchObject({
    output: expect.stringContaining('"token":"private-install-key"'),
  });
  const stored = readPluginConfigurationStore(f.rootDir).raw;
  await removeRuntimePlugin(
    {
      ...f,
      applyConfiguration: async () => ({ status: "ready" }),
      requireInactive: () => {},
    },
    { pluginId: "community-example" },
  );
  expect(existsSync(f.pluginRoot)).toBe(false);
  expect(readPluginConfigurationStore(f.rootDir).raw).toBe(stored);
  const second = await f.inspect();
  expect(second.payload.review.configuration.settings.query).toBe(
    "community news",
  );
  expect(second.payload.review.configuration.secrets[0].configured).toBe(true);
  expect(JSON.stringify(second.payload)).not.toContain("private-install-key");
  expect(
    (
      await f.install(second.payload.review, {
        revision: second.payload.review.configuration.revision,
        settings: second.payload.review.configuration.settings,
        secrets: {},
      })
    ).status,
  ).toBe(200);
});

test("missing required keys reject installation and restore package/selection state", async () => {
  const f = await installationFixture();
  const before = await readFile(f.configPath, "utf8");
  const inspected = await f.inspect();
  const result = await f.install(inspected.payload.review);
  expect(result.status).toBe(400);
  expect(result.payload.error).toBe("plugin_secret_required");
  expect(existsSync(f.pluginRoot)).toBe(false);
  expect(await readFile(f.configPath, "utf8")).toBe(before);
  expect(readPluginConfigurationStore(f.rootDir).raw).toBeUndefined();
});

test("a stale review cannot overwrite separately saved plugin values", async () => {
  const f = await installationFixture();
  const first = await f.inspect();
  // An invalid revision is rejected inside publication and rolls the new package back.
  const result = await f.install(first.payload.review, {
    revision: "stale",
    settings: {},
    secrets: { token: { action: "set", value: "private" } },
  });
  expect(result.status).toBe(409);
  expect(existsSync(f.pluginRoot)).toBe(false);
  expect(readPluginConfigurationStore(f.rootDir).raw).toBeUndefined();
});

test("installing with untouched settings stores only credentials and inherits plugin defaults", async () => {
  const f = await installationFixture();
  const review = (await f.inspect()).payload.review;
  const root = {
    querySelector: (selector: string) => {
      if (selector === '[data-plugin-secret-action="0"]')
        return { value: "set" };
      if (selector === '[data-plugin-secret-value="0"]')
        return { value: "install-default-test" };
      return null;
    },
  };
  const input = readPluginConfigurationFields(root, review.configuration, true);
  expect(input.settings).toEqual({});
  expect((await f.install(review, input)).status).toBe(200);
  const stored = readPluginConfigurationStore(f.rootDir).plugins[
    "community-example"
  ]!;
  expect(stored.settings).toEqual({});
  expect(stored.secrets.token!.value).toBe("install-default-test");
  expect(f.view().settingOverrides).toEqual([]);
  expect(f.view().settings.query).toBe("default query");
});
