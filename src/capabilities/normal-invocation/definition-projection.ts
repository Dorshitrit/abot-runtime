import type {
  ToolExecutionEffect,
  ToolNormalInvocationContract,
  ToolNormalInvocationFixedValue,
  ToolNormalInvocationPropertyInput,
} from "../tool-types.js";

export type ToolDefinitionProjection = Readonly<{
  params: Readonly<Record<string, string>>;
  executionEffect: ToolExecutionEffect;
}>;

/** Derive the model-facing flat parameter summary from the canonical operations. */
export function projectNormalInvocationDefinition(params: {
  toolName: string;
  contract: ToolNormalInvocationContract;
}): ToolDefinitionProjection {
  const projectedParams: Record<string, string> = {};
  for (const [operationIndex, operation] of params.contract.operations.entries()) {
    for (const [name, descriptor] of Object.entries(operation.input.properties)) {
      addParam(
        params.toolName,
        projectedParams,
        name,
        typeForInput(descriptor),
        `operations.${operationIndex}.input.properties.${name}`,
      );
    }
    for (const [name, value] of Object.entries(operation.fixedParams ?? {})) {
      addParam(
        params.toolName,
        projectedParams,
        name,
        typeForFixedValue(value),
        `operations.${operationIndex}.fixedParams.${name}`,
      );
    }
    if (operation.payload) {
      addParam(
        params.toolName,
        projectedParams,
        operation.payload.param,
        "string",
        `operations.${operationIndex}.payload.param`,
      );
    }
  }

  const effects = new Set(
    params.contract.operations.map((operation) => operation.effect),
  );
  return Object.freeze({
    params: Object.freeze({ ...projectedParams }),
    executionEffect:
      effects.size === 1
        ? params.contract.operations[0]!.effect
        : ("mixed" as const),
  });
}

function addParam(
  toolName: string,
  target: Record<string, string>,
  name: string,
  type: string,
  source: string,
): void {
  const current = target[name];
  if (current !== undefined && current !== type) {
    throw new Error(
      `Invalid tool definition for ${toolName} (${source}: parameter ${name} conflicts with derived type ${current})`,
    );
  }
  target[name] = type;
}

function typeForInput(descriptor: ToolNormalInvocationPropertyInput): string {
  if (descriptor.type === "array") {
    return `${scalarType(descriptor.items.type)}[]`;
  }
  return scalarType(descriptor.type);
}

function typeForFixedValue(value: ToolNormalInvocationFixedValue): string {
  return typeof value === "number" ? "number" : typeof value;
}

function scalarType(type: "string" | "number" | "integer" | "boolean") {
  return type === "integer" ? "number" : type;
}
