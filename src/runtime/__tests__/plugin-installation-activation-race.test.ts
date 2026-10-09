import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  installPluginPackage,
  inspectPluginPackage,
} from "../plugins/installation/service.js";
import { withConfigurationActivationSource } from "../../web-ui/local-runtime/configuration-activation-source.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import { installedRemovalFixture } from "./support/plugin-removal-fixture.js";
import {
  communityArchive,
  communityManifest,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";

const publication = vi.hoisted(() => ({
  target: "",
  beforeRename: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (source: string, target: string) => {
      if (target === publication.target) await publication.beforeRename?.();
      return fs.rename(source, target);
    },
  };
});
afterEach(() => {
  publication.target = "";
  publication.beforeRename = undefined;
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(["commit", "rollback"])(
  "Apply observes installation only after %s finishes",
  async (outcome) => {
    const f = await installedRemovalFixture();
    // The permissive default makes any published package immediately discoverable.
    await writeFile(f.configPath, JSON.stringify({ plugins: {} }));
    const target = join(f.rootDir, "plugins/concurrent");
    const download = sourceFetcher(
      await communityArchive({
        manifest: communityManifest("concurrent", "concurrent_ping"),
      }),
    );
    const review = await inspectPluginPackage(
      f.rootDir,
      pluginSource,
      download,
    );
    const reachedPublication = deferred();
    const releasePublication = deferred();
    publication.target = target;
    publication.beforeRename = async () => {
      reachedPublication.resolve();
      await releasePublication.promise;
    };
    const order: string[] = [];
    const install = installPluginPackage({
      rootDir: f.rootDir,
      configPath: f.configPath,
      download,
      input: { source: review.source, digest: review.digest },
      saveSelection: async (pluginId, transaction) => {
        order.push("selection");
        if (outcome === "rollback")
          throw new Error("selection rejected after publication");
        return setRuntimePluginEnabled(
          f,
          { pluginId, enabled: true },
          transaction,
        );
      },
    });
    // Observe rejection immediately to avoid an unhandled promise during the concurrent Apply.
    const installed = install.then(
      () => "committed",
      () => "rolled back",
    );
    await reachedPublication.promise;
    const fencedBeforeRename = existsSync(f.configPath + ".config.lock");
    const applied = withConfigurationActivationSource(
      f.configPath,
      async () => {
        order.push("apply");
        expect(existsSync(target)).toBe(outcome === "commit");
        expect(
          JSON.parse(await readFile(f.configPath, "utf8")).plugins,
        ).toEqual({});
        return { status: "ready" };
      },
    );
    releasePublication.resolve();
    await Promise.all([installed, applied]);
    expect(fencedBeforeRename).toBe(true);
    expect(order).toEqual(["selection", "apply"]);
    expect(await installed).toBe(
      outcome === "commit" ? "committed" : "rolled back",
    );
    expect(existsSync(target)).toBe(outcome === "commit");
  },
);
