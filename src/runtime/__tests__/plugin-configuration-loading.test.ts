import { expect, test, vi } from "vitest";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { pluginLoadConfiguration } from "../plugins/configuration-context.js";
import { withConfigurationActivationSource } from "../../web-ui/local-runtime/configuration-activation-source.js";
import { pluginConfigurationFixture } from "./support/plugin-configuration-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("saved settings and secrets load on the next config lifetime, leaving current and restored owners unchanged", async () => {
  const f = await pluginConfigurationFixture();
  vi.stubEnv("ABOT_CONFIGURATION_TEST_TOKEN", "inherited");
  const initial = loadConfiguredRuntimePlugins(f.config);
  const execute = (plugins: typeof initial) =>
    plugins[0]!.capabilities[0]!.execute({} as never);
  expect(await execute(initial)).toMatchObject({
    output: expect.stringContaining('"query":"default query"'),
  });
  await f.save(
    { query: "saved query" },
    { token: { action: "set", value: "local-token" } },
  );
  expect(await execute(initial)).toMatchObject({
    output: expect.stringContaining('"token":"inherited"'),
  });
  const replacement = loadConfiguredRuntimePlugins({ ...f.config });
  expect(await execute(replacement)).toMatchObject({
    output: expect.stringContaining('"token":"local-token"'),
  });
  expect(await execute(replacement)).toMatchObject({
    output: expect.stringContaining('"query":"saved query"'),
  });
  // Activation rollback reuses the previous canonical RuntimeConfig identity.
  expect(loadConfiguredRuntimePlugins(f.config)).toBe(initial);
  expect(await execute(initial)).toMatchObject({
    output: expect.stringContaining('"query":"default query"'),
  });
});

test("cleared required credentials reject a new owner while the existing owner remains usable", async () => {
  const f = await pluginConfigurationFixture();
  await f.save({}, { token: { action: "set", value: "first" } });
  const first = loadConfiguredRuntimePlugins(f.config);
  await f.save({}, { token: { action: "clear" } });
  expect(() => loadConfiguredRuntimePlugins({ ...f.config })).toThrow(
    "requires secret token",
  );
  expect(await first[0]!.capabilities[0]!.execute({} as never)).toMatchObject({
    output: expect.stringContaining('"token":"first"'),
  });
});

test("host exposes only declared settings and secrets and binds a stored secret to its env declaration", () => {
  vi.stubEnv("ABOT_CONFIGURATION_OTHER", "other-env");
  const values = pluginLoadConfiguration(
    "example",
    {
      settings: { defaults: { query: "default" } },
      secrets: { token: { env: "ABOT_CONFIGURATION_OTHER", required: true } },
    },
    {
      settings: { query: "override", hidden: "not-declared" },
      secrets: {
        token: { env: "OLD_ENV", value: "old-token" },
        hidden: { env: "HIDDEN", value: "hidden" },
      },
    },
  );
  expect(values.config).toEqual({ query: "override" });
  expect(values.secrets?.get("token")).toBe("other-env");
  expect(() => values.secrets?.get("hidden")).toThrow("undeclared secret");
});

test("Apply holds the same private-store lock through activation and restoration", async () => {
  const f = await pluginConfigurationFixture();
  const reached = deferred();
  const release = deferred();
  const order: string[] = [];
  const apply = withConfigurationActivationSource(
    f.configPath,
    async () => {
      reached.resolve();
      await release.promise;
      order.push("apply");
      return { status: "ready" };
    },
    undefined,
    f.rootDir,
  );
  await reached.promise;
  const save = f.save({ query: "after-apply" }).then(() => order.push("save"));
  expect(order).toEqual([]);
  release.resolve();
  await Promise.all([apply, save]);
  expect(order).toEqual(["apply", "save"]);
});
