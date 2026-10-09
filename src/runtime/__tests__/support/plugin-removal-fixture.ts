import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import {
  installPluginPackage,
  inspectPluginPackage,
} from "../../plugins/installation/service.js";
import { setRuntimePluginEnabled } from "../../../web-ui/plugin-management-service.js";
import {
  communityArchive,
  pluginSource,
  sourceFetcher,
} from "./plugin-installation-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
export async function installedRemovalFixture(archive?: Buffer) {
  const base = join(
    process.cwd(),
    ".codex/artifacts/plugin-removal-review-20261007/tests",
  );
  await mkdir(base, { recursive: true });
  const rootDir = await mkdtemp(join(base, "remove-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { allow: ["community-example"] } }),
  );
  const download = sourceFetcher(archive ?? (await communityArchive()));
  const review = await inspectPluginPackage(rootDir, pluginSource, download);
  await installPluginPackage({
    rootDir,
    download,
    input: { source: review.source, digest: review.digest },
    saveSelection: (pluginId, transaction) =>
      setRuntimePluginEnabled(
        { rootDir, configPath },
        { pluginId, enabled: true },
        transaction,
      ),
  });
  const path = join(rootDir, "plugins/community-example");
  const input = { pluginId: "community-example" };
  const selection = async () =>
    JSON.parse(await readFile(configPath, "utf8")).plugins;
  const requireInactive = vi.fn();
  const applyConfiguration = vi.fn(async (_expectedRevision: string) => {
    expect(existsSync(path)).toBe(true);
    expect((await selection()).disabledPluginIds).toContain(input.pluginId);
    return { status: "ready" as const };
  });
  return {
    rootDir,
    configPath,
    path,
    input,
    selection,
    requireInactive,
    applyConfiguration,
  };
}
