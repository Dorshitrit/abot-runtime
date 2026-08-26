import type {
  ToolDefinition,
  ToolNormalInvocationOperation,
} from "../../../../capabilities/tool-types.js";

export function projectRuntimePathBindings(
  definition: ToolDefinition,
  operation: ToolNormalInvocationOperation,
): readonly Readonly<{ param: string; default?: "." }>[] {
  const bindings = new Map<
    string,
    Readonly<{ param: string; default?: "." }>
  >();
  for (const binding of definition.runtimePathBindings ?? []) {
    if (binding.operationId === operation.operationId) {
      bindings.set(
        binding.param,
        Object.freeze({
          param: binding.param,
          ...(binding.default ? { default: binding.default } : {}),
        }),
      );
    }
  }
  const operationTargetParam =
    definition.payloadChannelSpec?.targetRole === "operation_target"
      ? definition.payloadChannelSpec.targetParam
      : undefined;
  if (operationTargetParam) {
    bindings.set(
      operationTargetParam,
      Object.freeze({ param: operationTargetParam }),
    );
  }
  return Object.freeze([...bindings.values()]);
}
