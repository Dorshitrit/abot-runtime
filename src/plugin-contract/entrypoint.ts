import type {
  ResolvedRuntimeToolPath,
  RuntimeToolPathError,
  RuntimeToolPathErrorCode,
  RuntimeToolPathLocation,
  RuntimeToolPathResolver,
  ToolAvailabilityEntry,
  ToolCall,
  ToolCallAdapter,
  ToolCallAdapterInput,
  ToolCatalogGroup,
  ToolDefinition,
  ToolExecutionContext,
  ToolImplementation,
  ToolImplementationOutput,
} from "../capabilities/tool-types.js";
import type { ToolNormalInvocationContract } from "../capabilities/normal-invocation/contracts.js";

export type RuntimePluginLoadContext = {
  id: string;
  path: string;
  stateDir: string;
  rootDir: string;
  runtimeId: string;
  agentBridgeUrl: string;
  runtimePaths: {
    rootDir: string;
    runtimeDir: string;
    agentWorkDir: string;
    sessionsDir: string;
    attachmentsDir: string;
    workspaceDir: string;
    sharedDir: string;
    compiledDir: string;
    traceFile: string;
  };
  runtimePathResolver: RuntimeToolPathResolver;
  config?: Record<string, unknown>;
  secrets?: Readonly<{
    get(name: string): string | undefined;
  }>;
};

export type RuntimePluginEntrypoint = Readonly<{
  handlers: Readonly<Record<string, ToolImplementation>>;
  adapters?: Readonly<Record<string, ToolCallAdapter>>;
}>;

export type RuntimePluginEntrypointFactory = (
  context: RuntimePluginLoadContext & Readonly<{ pluginRoot: string }>,
) => RuntimePluginEntrypoint;

export type {
  ResolvedRuntimeToolPath,
  RuntimeToolPathError,
  RuntimeToolPathErrorCode,
  RuntimeToolPathLocation,
  RuntimeToolPathResolver,
  ToolAvailabilityEntry,
  ToolCall,
  ToolCallAdapter,
  ToolCallAdapterInput,
  ToolCatalogGroup,
  ToolDefinition,
  ToolExecutionContext,
  ToolImplementation,
  ToolImplementationOutput,
  ToolNormalInvocationContract,
};
