import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import createFilesystemPlugin from "../../../../plugins/filesystem/source/index.js";
import type { RuntimePluginEntrypoint } from "../../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createRuntimeToolPathResolver } from "../../capabilities/runtime-target-path.js";
import { loadConfiguredRuntimePlugins } from "../../plugins/loader.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";

export async function createDevViewLocatorFixture() {
  const config = await createRuntimeConfig();
  await mkdir(config.paths.agentWorkDir, { recursive: true });
  const pluginRoot = join(process.cwd(), "plugins", "filesystem");
  const plugin: RuntimePluginEntrypoint = createFilesystemPlugin({
    id: "filesystem",
    path: join(pluginRoot, "plugin.json"),
    pluginRoot,
    stateDir: join(config.paths.runtimeDir, "plugins", "filesystem"),
    rootDir: config.paths.rootDir,
    runtimeId: "dev-view-locator-test",
    agentBridgeUrl: "ws://unused",
    runtimePaths: config.paths,
    runtimePathResolver: createRuntimeToolPathResolver(config.paths),
  });
  const modules = loadConfiguredRuntimePlugins({
    ...config,
    plugins: { allow: ["filesystem"] },
  }).flatMap(({ capabilities }) =>
    capabilities.map((capability) => ({
      definition: capability.definition,
      normalInvocation: capability.normalInvocation,
      implementation: plugin.handlers[capability.definition.name]!,
      adapter: plugin.adapters?.[capability.definition.name],
    })),
  );
  return {
    config,
    plugin,
    registry: createConfiguredToolRegistry(config, modules),
  };
}
