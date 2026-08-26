import { createRequestToolModelInvoker } from "../adapters/request-tool-model-invoker.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "./configured-tool-registry.js";
import { bindRequestToolRegistry } from "./request-bound-tool-registry.js";

/**
 * Binds the runtime's globally configured tools to one request. Exact
 * capability availability is narrowed separately by declarative role config.
 * This boundary contains no orchestration-policy selection.
 */
export function createRequestRuntimeToolRegistry(
  params: Readonly<{
    request: BoundRequestModelInvocationContext;
    requestAttachments?: readonly ToolRequestAttachment[];
    runtimeConfig?: RuntimeConfig;
    toolRegistryOverride?: ToolRegistry;
  }>,
): ToolRegistry {
  return bindRequestToolRegistry({
    registry:
      params.toolRegistryOverride ??
      createConfiguredToolRegistry(params.runtimeConfig, []),
    modelInvoker: createRequestToolModelInvoker(params.request),
    ...(params.requestAttachments
      ? { requestAttachments: params.requestAttachments }
      : {}),
  });
}
