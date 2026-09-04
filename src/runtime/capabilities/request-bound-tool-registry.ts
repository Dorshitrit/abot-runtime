import type {
  RegisteredToolNormalInvocation,
  ToolAvailabilityEntry,
  ToolExecutionSharedState,
  ToolModelInvoker,
  ToolRequestAttachment,
} from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { projectAvailableTools } from "./tool-availability.js";

/**
 * Adds trusted request services to an already config-filtered Tool Registry.
 * Tools remain opaque to the request flow.
 */
export function bindRequestToolRegistry(
  params: Readonly<{
    registry: ToolRegistry;
    modelInvoker: ToolModelInvoker;
    requestAttachments?: readonly ToolRequestAttachment[];
  }>,
): ToolRegistry {
  const registry = params.registry;
  let normalInvocations: readonly RegisteredToolNormalInvocation[] | undefined;
  let normalInvocationsResolved = false;
  let availableTools: readonly ToolAvailabilityEntry[] | undefined;
  let availableToolsResolved = false;

  function resolveNormalInvocations():
    | readonly RegisteredToolNormalInvocation[]
    | undefined {
    if (!normalInvocationsResolved) {
      normalInvocations = registry.listNormalInvocations?.();
      normalInvocationsResolved = true;
    }
    return normalInvocations;
  }

  function resolveAvailableTools():
    | readonly ToolAvailabilityEntry[]
    | undefined {
    if (!availableToolsResolved) {
      availableTools = projectAvailableTools(resolveNormalInvocations());
      availableToolsResolved = true;
    }
    return availableTools;
  }

  return Object.freeze({
    listDefinitions: () => registry.listDefinitions(),
    ...(registry.listNormalInvocations
      ? { listNormalInvocations: () => resolveNormalInvocations()! }
      : {}),
    getDefinition: (name: string) => registry.getDefinition(name),
    ...(registry.getAdapter
      ? { getAdapter: (name: string) => registry.getAdapter!(name) }
      : {}),
    hasToolsAvailable: () => registry.hasToolsAvailable(),
    getImplementations: () => registry.getImplementations(),
    prepareSharedState: (sharedState?: ToolExecutionSharedState) => {
      const requestAvailableTools = resolveAvailableTools();
      const requestState: ToolExecutionSharedState = {
        ...(sharedState ?? {}),
        ...(requestAvailableTools !== undefined
          ? { availableTools: requestAvailableTools }
          : {}),
        ...(params.requestAttachments && params.requestAttachments.length > 0
          ? { requestAttachments: params.requestAttachments }
          : {}),
      };
      return registry.prepareSharedState
        ? registry.prepareSharedState(requestState)
        : requestState;
    },
    execute: (call, options) =>
      registry.execute(call, {
        ...options,
        modelInvoker: params.modelInvoker,
      }),
  });
}
