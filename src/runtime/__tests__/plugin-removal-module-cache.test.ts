import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";
afterEach(removePluginSelectionFixtures);
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import {
  inspectPluginPackage,
  installPluginPackage,
} from "../plugins/installation/service.js";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import { installedRemovalFixture } from "./support/plugin-removal-fixture.js";
import {
  communityArchive,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";

const require = createRequire(import.meta.url);
function archive(version: number) {
  return communityArchive({
    code: `const helper = require('./helper.cjs'); module.exports = () => ({ handlers: { community_ping: async () => ({ ok: true, output: 'entry-${version}:' + helper, producedNewInformation: true }) } });`,
    extra: {
      "repository-commit/src/helper.cjs": `module.exports = 'helper-${version}';`,
    },
  });
}

test("remove and reinstall in one process loads new entry and transitive helper without evicting neighbors", async () => {
  const f = await installedRemovalFixture(await archive(1));
  const neighbor = f.path + "-neighbor";
  await mkdir(neighbor);
  const neighborFile = join(neighbor, "index.cjs");
  await writeFile(neighborFile, "module.exports = { retained: true };");
  const shared = require(neighborFile);
  const config = await createPluginSelectionFixture({
    allow: [f.input.pluginId],
  });
  // Apply creates a new RuntimeConfig; the process-wide CommonJS cache survives it.
  const load = () =>
    loadConfiguredRuntimePlugins({
      ...config,
      paths: { ...config.paths, rootDir: f.rootDir },
    }).find((p) => p.id === f.input.pluginId)!;
  const first = load();
  const invoke = (plugin: typeof first) =>
    plugin.capabilities[0]!.execute({} as never);
  expect(await invoke(first)).toMatchObject({ output: "entry-1:helper-1" });
  const entry = join(f.path, "src/index.cjs");
  const helper = join(f.path, "src/helper.cjs");
  expect(require.cache[entry]).toBeDefined();
  expect(require.cache[helper]).toBeDefined();
  await removeRuntimePlugin(f, f.input);
  expect(require.cache[entry]).toBeUndefined();
  expect(require.cache[helper]).toBeUndefined();
  expect(require(neighborFile)).toBe(shared);
  const download = sourceFetcher(await archive(2));
  const review = await inspectPluginPackage(f.rootDir, pluginSource, download);
  await installPluginPackage({
    rootDir: f.rootDir,
    download,
    input: { source: review.source, digest: review.digest },
    saveSelection: (pluginId, transaction) =>
      setRuntimePluginEnabled(f, { pluginId, enabled: true }, transaction),
  });
  expect(await invoke(load())).toMatchObject({ output: "entry-2:helper-2" });
  expect(require(neighborFile)).toBe(shared);
});
