import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  inspectPluginPackage,
  installPluginPackage,
} from "../plugins/installation/service.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";
import {
  communityArchive,
  communityManifest,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await removePluginSelectionFixtures();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const parent = join(
    process.cwd(),
    ".codex/artifacts/plugin-installation-20261006/tests",
  );
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "package-"));
  roots.push(directory);
  return directory;
}

describe("community plugin installation", () => {
  test("review and installation never execute plugin code; the normal loader picks it up after activation", async () => {
    const config = await createPluginSelectionFixture({
      allow: ["community-example"],
    });
    const configPath = join(config.paths.rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ plugins: { allow: ["fixture-active"] } }),
    );
    const download = sourceFetcher(await communityArchive());
    const review = await inspectPluginPackage(
      config.paths.rootDir,
      pluginSource,
      download,
    );
    expect(review).toMatchObject({
      id: "community-example",
      source: pluginSource,
    });
    expect(await readdir(config.paths.rootDir)).not.toContain(
      "community-example",
    );
    await installPluginPackage({
      rootDir: config.paths.rootDir,
      input: { source: review.source, digest: review.digest },
      download,
      saveSelection: (pluginId, transaction) =>
        setRuntimePluginEnabled(
          { rootDir: config.paths.rootDir, configPath },
          { pluginId, enabled: true },
          transaction,
        ),
    });
    const installed = loadConfiguredRuntimePlugins(config).find(
      (plugin) => plugin.id === "community-example",
    );
    expect(installed?.capabilities).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          join(
            config.paths.rootDir,
            "plugins/community-example/.abot-install.json",
          ),
          "utf8",
        ),
      ).source,
    ).toEqual(pluginSource);
    expect(
      JSON.parse(await readFile(configPath, "utf8")).plugins.allow,
    ).toEqual(["fixture-active", "community-example"]);
  });

  test("code that throws at module load is not run during either installation phase", async () => {
    const directory = await root();
    const download = sourceFetcher(
      await communityArchive({
        code: 'throw new Error("must not execute during installation");',
      }),
    );
    const review = await inspectPluginPackage(
      directory,
      pluginSource,
      download,
    );
    await expect(
      installPluginPackage({
        rootDir: directory,
        input: { source: review.source, digest: review.digest },
        download,
        saveSelection: async () => ({}),
      }),
    ).resolves.toMatchObject({ installed: { id: "community-example" } });
  });

  test("refuses changed bytes, incomplete packages and conflicting capabilities without committing files", async () => {
    const directory = await root();
    const download = sourceFetcher(await communityArchive());
    const review = await inspectPluginPackage(
      directory,
      pluginSource,
      download,
    );
    await expect(
      installPluginPackage({
        rootDir: directory,
        input: { source: review.source, digest: "0".repeat(64) },
        download,
        saveSelection: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "plugin_review_changed" });
    const broken = communityManifest();
    broken.extensions["ai.abot.runtime"].entrypoint = "./missing.cjs";
    await expect(
      inspectPluginPackage(
        directory,
        pluginSource,
        sourceFetcher(await communityArchive({ manifest: broken })),
      ),
    ).rejects.toMatchObject({ code: "plugin_package_invalid" });
    await expect(
      inspectPluginPackage(
        directory,
        pluginSource,
        sourceFetcher(
          await communityArchive({
            manifest: communityManifest("community-example", "dev_view"),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "plugin_capability_conflict" });
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".abot-plugin-install-"),
      ),
    ).toEqual([]);
  });

  test.each([
    ["", ".abot-install.json"],
    ["", ".ABOT-INSTALL.JSON"],
    ["", ".abot-install.json/child"],
    ["packages/community", ".abot-install.json"],
  ])(
    "rejects reserved installer metadata before review at %s/%s",
    async (subpath, name) => {
      const directory = await root();
      const source = { ...pluginSource, path: subpath };
      const path = ["repository-commit", subpath, name]
        .filter(Boolean)
        .join("/");
      const download = sourceFetcher(
        await communityArchive({
          subpath,
          extra: { [path]: "repository-owned content" },
        }),
      );
      await expect(
        inspectPluginPackage(directory, source, download),
      ).rejects.toMatchObject({
        code: "plugin_package_invalid",
        message: expect.stringContaining("reserved .abot-install.json"),
      });
      const saveSelection = vi.fn();
      await expect(
        installPluginPackage({
          rootDir: directory,
          input: { source, digest: "0".repeat(64) },
          download,
          saveSelection,
        }),
      ).rejects.toMatchObject({ code: "plugin_package_invalid" });
      expect(saveSelection).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  test.each(["con", "nul", "com1", "lpt9", "con.example", "aux.data"])(
    "rejects the non-portable plugin ID %s before review and installation",
    async (id) => {
      const directory = await root();
      const download = sourceFetcher(
        await communityArchive({ manifest: communityManifest(id) }),
      );
      await expect(
        inspectPluginPackage(directory, pluginSource, download),
      ).rejects.toMatchObject({
        code: "plugin_package_invalid",
        message: expect.stringContaining("portable installation folder"),
      });
      const saveSelection = vi.fn();
      await expect(
        installPluginPackage({
          rootDir: directory,
          input: { source: pluginSource, digest: "0".repeat(64) },
          download,
          saveSelection,
        }),
      ).rejects.toMatchObject({ code: "plugin_package_invalid" });
      expect(saveSelection).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  test.each(["console", "community.con", "com10"])(
    "accepts the portable plugin ID %s",
    async (id) => {
      const directory = await root();
      const download = sourceFetcher(
        await communityArchive({ manifest: communityManifest(id) }),
      );
      const review = await inspectPluginPackage(
        directory,
        pluginSource,
        download,
      );
      await expect(
        installPluginPackage({
          rootDir: directory,
          input: { source: review.source, digest: review.digest },
          download,
          saveSelection: async () => ({}),
        }),
      ).resolves.toMatchObject({ installed: { id } });
    },
  );

  test("selection failure rolls back the new folder and preserves unrelated files", async () => {
    const directory = await root();
    const download = sourceFetcher(await communityArchive());
    const review = await inspectPluginPackage(
      directory,
      pluginSource,
      download,
    );
    await expect(
      installPluginPackage({
        rootDir: directory,
        input: { source: review.source, digest: review.digest },
        download,
        saveSelection: async () => {
          throw new Error("save failed");
        },
      }),
    ).rejects.toThrow("save failed");
    expect(await readdir(join(directory, "plugins"))).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".abot-plugin-install-"),
      ),
    ).toEqual([]);
  });

  test("does not overwrite installed IDs and rejects an escaping destination", async () => {
    const directory = await root();
    const download = sourceFetcher(await communityArchive());
    const review = await inspectPluginPackage(
      directory,
      pluginSource,
      download,
    );
    const options = {
      rootDir: directory,
      input: { source: review.source, digest: review.digest },
      download,
      saveSelection: async () => ({}),
    };
    await installPluginPackage(options);
    await expect(installPluginPackage(options)).rejects.toMatchObject({
      code: "plugin_already_installed",
    });
    const outside = await root();
    const consumer = await root();
    await symlink(outside, join(consumer, "plugins"));
    await expect(
      installPluginPackage({ ...options, rootDir: consumer }),
    ).rejects.toMatchObject({ code: "plugin_destination_invalid" });
    expect(await readdir(outside)).toEqual([]);
  });

  test("installs a selected repository subdirectory", async () => {
    const directory = await root();
    const source = { ...pluginSource, path: "packages/community" };
    const download = sourceFetcher(
      await communityArchive({ subpath: source.path }),
    );
    const review = await inspectPluginPackage(directory, source, download);
    await expect(
      installPluginPackage({
        rootDir: directory,
        input: { source: review.source, digest: review.digest },
        download,
        saveSelection: async () => ({}),
      }),
    ).resolves.toMatchObject({ installed: { source } });
  });
});
