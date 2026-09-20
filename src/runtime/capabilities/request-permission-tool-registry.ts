import { captureRequestPermissionCatalog } from "./request-permission-catalog.js";
import { type ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type {
  ToolExecutionSharedState,
  ToolImplementation,
} from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";

/** Captures user authority once; all discovery and execution use the same gate. */
export function restrictToolRegistryToRequestMode(
  registry: ToolRegistry,
  mode: ToolPermissionMode,
): ToolRegistry {
  const catalog = captureRequestPermissionCatalog(registry, mode);
  const isRequestToolAvailable = catalog.isRequestToolAvailable;
  const rejectUnavailableTool = (tool: string) => ({
    ok: false,
    tool,
    output:
      "This tool is unavailable for the captured request permission mode.",
    producedNewInformation: false,
    error: "This tool is unavailable for the captured request permission mode.",
    errorCode: "tool_permission_mode_required",
  });
  const bindAuthority = (
    state?: ToolExecutionSharedState,
  ): ToolExecutionSharedState => ({
    ...state,
    requestContext: Object.freeze({
      agentMode: state?.requestContext?.agentMode ?? "fast",
      ...state?.requestContext,
      toolPermissionMode: mode,
    }),
  });
  const implementations: Record<string, ToolImplementation> = {};
  for (const [name, implementation] of Object.entries(
    registry.getImplementations(),
  )) {
    if (!isRequestToolAvailable(name)) continue;
    implementations[name] = (params, context) =>
      implementation(params, {
        ...context,
        sharedState: bindAuthority(context?.sharedState),
      });
  }
  return Object.freeze({
    listDefinitions: catalog.listDefinitions,
    ...(registry.listNormalInvocations
      ? {
          listNormalInvocations: () => catalog.listNormalInvocations()!,
        }
      : {}),
    getDefinition: catalog.getDefinition,
    ...(registry.getAdapter
      ? {
          getAdapter: (name: string) =>
            isRequestToolAvailable(name)
              ? registry.getAdapter!(name)
              : undefined,
        }
      : {}),
    hasToolsAvailable: () =>
      catalog.listDefinitions().length > 0 ||
      (catalog.listNormalInvocations()?.length ?? 0) > 0,
    getImplementations: () => ({ ...implementations }),
    prepareSharedState: (state?: ToolExecutionSharedState) =>
      bindAuthority(
        registry.prepareSharedState
          ? registry.prepareSharedState(state)
          : state,
      ),
    execute: (call, options) => {
      if (!isRequestToolAvailable(call.tool))
        return Promise.resolve(rejectUnavailableTool(call.tool));
      return registry.execute(call, {
        ...options,
        sharedState: bindAuthority(options?.sharedState),
      });
    },
  });
}
