import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import createExecPlugin from "../../../../plugins/exec/source/index.js";
import type {
  RuntimePluginEntrypoint,
  RuntimePluginLoadContext,
} from "../../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createRuntimeToolPathResolver } from "../../capabilities/runtime-target-path.js";
import { loadConfiguredRuntimePlugins } from "../../plugins/loader.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";

export async function createExecCommandPathFixture() {
  const config = await createRuntimeConfig();
  await mkdir(config.paths.agentWorkDir, { recursive: true });
  const pluginRoot = join(process.cwd(), "plugins", "exec");
  const context: RuntimePluginLoadContext & Readonly<{ pluginRoot: string }> = {
    id: "exec",
    path: join(pluginRoot, "plugin.json"),
    pluginRoot,
    stateDir: join(config.paths.runtimeDir, "plugins", "exec"),
    rootDir: config.paths.rootDir,
    runtimeId: "exec-command-path-test",
    agentBridgeUrl: "ws://unused",
    runtimePaths: config.paths,
    runtimePathResolver: createRuntimeToolPathResolver(config.paths),
    config: { timeoutMs: 5000, yieldAfterMs: 5000 },
  };
  const plugin: RuntimePluginEntrypoint = createExecPlugin(context);
  // Keep canonical manifest compilation and execute the current handwritten
  // source. Generated-entrypoint parity is checked by check:plugin-build.
  const modules = loadConfiguredRuntimePlugins({
    ...config,
    plugins: { allow: ["exec"] },
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
    context,
    plugin,
    registry: createConfiguredToolRegistry(config, modules),
  };
}
