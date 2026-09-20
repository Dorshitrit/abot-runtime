import { bindRequestWorkingDirectory } from "./request-working-directory.js";
import { createToolRegistry as createToolRegistryInstance } from "../../capabilities/registry.js";
import { executeToolCall } from "../../capabilities/tool-executor.js";
import type {
  ToolExecutionSharedState,
  ToolModuleDeclaration,
} from "../../capabilities/tool-types.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import { createRuntimeToolPathResolver } from "./runtime-target-path.js";
import { prepareRequestToolModules } from "./request-module-preparation.js";

export function createConfiguredToolRegistry(
  config: RuntimeConfig | undefined,
  modules: readonly ToolModuleDeclaration[],
): ToolRegistry {
  const baseRegistry = createToolRegistryInstance({ modules });
  const getImplementations = () => baseRegistry.getImplementations();
  const prepareSharedState = (
    sharedState: ToolExecutionSharedState = {},
  ): ToolExecutionSharedState =>
    config
      ? {
          ...sharedState,
          runtimePaths: {
            rootDir: config.paths.rootDir,
            runtimeDir: config.paths.runtimeDir,
            agentWorkDir: config.paths.agentWorkDir,
            sessionsDir: config.paths.sessionsDir,
            workspaceDir: config.paths.workspaceDir,
            sharedDir: config.paths.sharedDir,
            compiledDir: config.paths.compiledDir,
            traceFile: config.paths.traceFile,
          },
        }
      : { ...sharedState };

  return {
    ...(modules.some((module) => module.prepareRequest)
      ? {
          prepareRequest: async () =>
            createConfiguredToolRegistry(
              config,
              await prepareRequestToolModules(modules),
            ),
        }
      : {}),
    listDefinitions: () => baseRegistry.getDefinitions(),
    listNormalInvocations: () => baseRegistry.getNormalInvocations(),
    getDefinition: (name: string) => baseRegistry.getByName(name),
    getAdapter: (name: string) => baseRegistry.getAdapterByName(name),
    hasToolsAvailable: baseRegistry.hasToolsAvailable,
    getImplementations,
    prepareSharedState,
    execute: (call, options) => {
      const configuredState = prepareSharedState(options?.sharedState);
      const sharedState = bindRequestWorkingDirectory(
        configuredState,
        options?.requestWorkingDirectory,
      );
      return executeToolCall(call, {
        ...options,
        sharedState,
        runtimePathResolver: createRuntimeToolPathResolver(
          sharedState.runtimePaths,
        ),
        implementations: getImplementations(),
      });
    },
  };
}
