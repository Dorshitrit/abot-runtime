import type {
  CanonicalToolDefinitionDeclaration,
  ToolCallAdapter,
  ToolImplementation,
} from "../../capabilities/tool-types.js";
import type { ToolNormalInvocationContract } from "../../capabilities/normal-invocation/contracts.js";

export type CompiledPluginCapability = Readonly<{
  definition: CanonicalToolDefinitionDeclaration;
  normalInvocation: ToolNormalInvocationContract;
  execute: ToolImplementation;
  adapter?: ToolCallAdapter;
}>;

export type CompiledRuntimePlugin = Readonly<{
  id: string;
  name: string;
  version?: string;
  capabilities: readonly CompiledPluginCapability[];
  skills: Readonly<Record<string, string>>;
  capabilitySkills: Readonly<Record<string, readonly string[]>>;
}>;
