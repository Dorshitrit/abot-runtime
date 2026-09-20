import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDefaultToolRegistry } from "../default-adapters.js";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";

afterEach(removePluginSelectionFixtures);

async function malformedPlugin(root: string, id: string): Promise<void> {
  const directory = join(root, "plugins", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "plugin.json"), "{invalid JSON");
}

describe("disabled plugin manifest isolation", () => {
  test.each([{ enabled: false }, { allow: ["*"], deny: ["*"] }])(
    "global disable does not read malformed packages: %j",
    async (selection) => {
      const config = await createPluginSelectionFixture(selection);
      await malformedPlugin(config.paths.rootDir, "broken-fixture");
      expect(loadConfiguredRuntimePlugins(config)).toEqual([]);
      expect(createDefaultToolRegistry(config).listDefinitions()).toEqual([]);
    },
  );

  test.each(["broken-fixture", "exec", "system"])(
    "an explicitly denied %s package cannot block a selected package",
    async (id) => {
      const config = await createPluginSelectionFixture({
        allow: ["fixture-active"],
        deny: [id],
      });
      await malformedPlugin(config.paths.rootDir, id);
      const registry = createDefaultToolRegistry(config);
      expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
        "fixture_ping",
      ]);
      await expect(
        registry.execute({ tool: "fixture_ping", params: {} }),
      ).resolves.toMatchObject({ ok: true, output: "fixture:1" });
      expect(() => discoverAgentPluginManifests(config.paths.rootDir)).toThrow(
        /Failed to load runtime plugin manifest/,
      );
    },
  );

  test.each([
    { allow: ["broken-fixture"] },
    { allow: ["*"], deny: ["broken-fixture.one_capability"] },
    { allow: ["fixture_ping"] },
  ])(
    "unexcluded malformed metadata still fails validation: %j",
    async (selection) => {
      const config = await createPluginSelectionFixture(selection);
      await malformedPlugin(config.paths.rootDir, "broken-fixture");
      expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
        /Failed to load runtime plugin manifest/,
      );
    },
  );

  test("a bare capability allow selector still discovers a differently named package", async () => {
    const config = await createPluginSelectionFixture({
      allow: ["fixture_ping"],
    });
    expect(loadConfiguredRuntimePlugins(config).map(({ id }) => id)).toEqual([
      "fixture-active",
    ]);
  });

  test("an unexcluded manifest must still match its directory identity", async () => {
    const config = await createPluginSelectionFixture({ allow: ["*"] });
    const directory = join(config.paths.rootDir, "plugins", "wrong-identity");
    await mkdir(directory);
    const manifest = await readFile(
      join(config.paths.rootDir, "plugins", "fixture-active", "plugin.json"),
      "utf8",
    );
    await writeFile(join(directory, "plugin.json"), manifest);
    expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
      /must match plugin.json name/,
    );
  });

  test("an excluded escaping directory is never followed, while selected containment stays enforced", async () => {
    const config = await createPluginSelectionFixture({
      allow: ["fixture-active"],
      deny: ["escaping-fixture"],
    });
    const outside = join(config.paths.rootDir, "outside-package");
    await mkdir(outside);
    await symlink(
      outside,
      join(config.paths.rootDir, "plugins", "escaping-fixture"),
      "dir",
    );
    expect(loadConfiguredRuntimePlugins(config).map(({ id }) => id)).toEqual([
      "fixture-active",
    ]);
    config.plugins = { allow: ["*"] };
    expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
      /resolves outside rootDir\/plugins/,
    );
  });

  test("denying a capability does not skip validation of its containing package", async () => {
    const config = await createPluginSelectionFixture({
      allow: ["fixture-active"],
      deny: ["fixture-active.fixture_ping"],
    });
    expect(loadConfiguredRuntimePlugins(config)).toEqual([]);
    await writeFile(
      join(config.paths.rootDir, "plugins", "fixture-active", "plugin.json"),
      "{invalid JSON",
    );
    const freshConfig = { ...config };
    expect(() => loadConfiguredRuntimePlugins(freshConfig)).toThrow(
      /Failed to load runtime plugin manifest/,
    );
  });
});
