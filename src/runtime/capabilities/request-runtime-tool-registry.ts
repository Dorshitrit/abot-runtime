import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import { restrictToolRegistryToRequestMode } from "./request-permission-tool-registry.js";
import { createRequestToolModelInvoker } from "../adapters/request-tool-model-invoker.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { RuntimeModelPluginConfig } from "../config/model-plugin-config.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "./configured-tool-registry.js";
import { bindRequestToolRegistry } from "./request-bound-tool-registry.js";
import { DEFAULT_REQUEST_EXECUTION_POLICY_ID } from "../../shared/request-execution-policy.js";

/**
 * Binds the runtime's globally configured tools to one request. Exact
 * capability availability is narrowed separately by declarative role config.
 * This boundary contains no orchestration-policy selection.
 */
export function createRequestRuntimeToolRegistry(
  params: Readonly<{
    request: BoundRequestModelInvocationContext;
    toolPermissionMode?: ToolPermissionMode;
    modelPlugins?: RuntimeModelPluginConfig;
    executionPolicy?: string;
    requestAttachments?: readonly ToolRequestAttachment[];
    runtimeConfig?: RuntimeConfig;
    requestWorkingDirectory?: string;
    toolRegistryOverride?: ToolRegistry;
  }>,
): ToolRegistry {
  const registry = restrictToolRegistryToRequestMode(
    params.toolRegistryOverride ??
      createConfiguredToolRegistry(params.runtimeConfig, []),
    params.toolPermissionMode ?? "ask",
    params.modelPlugins,
    params.executionPolicy ?? DEFAULT_REQUEST_EXECUTION_POLICY_ID,
  );
  return bindRequestToolRegistry({
    registry,
    modelInvoker: createRequestToolModelInvoker(params.request),
    requestWorkingDirectory: params.requestWorkingDirectory,
    ...(params.requestAttachments
      ? { requestAttachments: params.requestAttachments }
      : {}),
  });
}
