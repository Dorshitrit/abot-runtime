import type {
  ToolCatalogGroup,
  ToolDefinition,
  ToolDevelopmentRole,
  ToolExecutionEffect,
} from "../tool-types.js";
import { isToolCatalogGroupId } from "../tool-types.js";
import { isToolDefinitionRecordValue } from "./definition-shape.js";

const ROUTING_CAPABILITIES: readonly ToolDefinition["routingCapability"][] = [
  "filesystem_inspection",
  "filesystem_mutation",
  "semantic_lookup",
  "semantic_mutation",
  "web_lookup",
];

const DEVELOPMENT_ROLES: readonly ToolDevelopmentRole[] = [
  "inspect",
  "establish",
  "mutate",
  "verify",
  "auxiliary",
];

const EXECUTION_EFFECTS: readonly ToolExecutionEffect[] = [
  "read_only",
  "mutating",
  "mixed",
];

export function isRoutingCapability(
  value: unknown,
): value is ToolDefinition["routingCapability"] {
  if (typeof value !== "string") return false;
  return ROUTING_CAPABILITIES.includes(
    value as ToolDefinition["routingCapability"],
  );
}

export function isDevelopmentRole(
  value: unknown,
): value is ToolDevelopmentRole {
  if (typeof value !== "string") return false;
  return DEVELOPMENT_ROLES.includes(value as ToolDevelopmentRole);
}

export function isExecutionEffect(
  value: unknown,
): value is ToolExecutionEffect {
  if (typeof value !== "string") return false;
  return EXECUTION_EFFECTS.includes(value as ToolExecutionEffect);
}

export function parseToolCatalogGroups(
  toolName: string,
  value: unknown,
): ToolCatalogGroup[] {
  if (value === undefined) return ["other"];
  if (!hasUniqueSupportedToolCatalogGroups(value)) {
    throw new Error(`Invalid tool definition for ${toolName} (catalogGroups)`);
  }
  return [...value];
}

function hasUniqueSupportedToolCatalogGroups(
  value: unknown,
): value is ToolCatalogGroup[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  if (value.some((group) => !isToolCatalogGroupId(group))) return false;
  return new Set(value).size === value.length;
}

export function parseParamsByCommand(
  toolName: string,
  raw: unknown,
): ToolDefinition["paramsByCommand"] {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand)`,
    );
  }
  const discriminator = raw.discriminator;
  const rawVariants = raw.variants;
  if (typeof discriminator !== "string" || discriminator.trim().length === 0) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand.discriminator)`,
    );
  }
  if (!isToolDefinitionRecordValue(rawVariants)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand.variants)`,
    );
  }
  const variants: Record<string, Record<string, string>> = {};
  for (const [variantName, variantParams] of Object.entries(rawVariants)) {
    variants[variantName] = parseCommandVariantParameters(
      toolName,
      variantName,
      variantParams,
    );
  }
  return { discriminator, variants };
}

function parseCommandVariantParameters(
  toolName: string,
  variantName: string,
  raw: unknown,
): Record<string, string> {
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (paramsByCommand.variants.${variantName})`,
    );
  }
  const parsed: Record<string, string> = {};
  for (const [paramName, paramType] of Object.entries(raw)) {
    if (typeof paramType !== "string") {
      throw new Error(
        `Invalid tool definition for ${toolName} (paramsByCommand.variants.${variantName}.${paramName})`,
      );
    }
    parsed[paramName] = paramType;
  }
  return parsed;
}

export function parseRuntimePathBindings(
  toolName: string,
  raw: unknown,
): ToolDefinition["runtimePathBindings"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    throw new Error(
      `Invalid tool definition for ${toolName} (runtimePathBindings)`,
    );
  }
  const identities = new Set<string>();
  return raw.map((value, index) =>
    parseRuntimePathBinding(toolName, value, index, identities),
  );
}

function parseRuntimePathBinding(
  toolName: string,
  value: unknown,
  index: number,
  identities: Set<string>,
): NonNullable<ToolDefinition["runtimePathBindings"]>[number] {
  if (!isToolDefinitionRecordValue(value)) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  const keys = Object.keys(value);
  if (keys.length !== 3 && keys.length !== 4) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (!Object.hasOwn(value, "operationId")) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (!Object.hasOwn(value, "param")) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (!Object.hasOwn(value, "base")) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (keys.some((key) => !isRuntimePathBindingKey(key))) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (typeof value.operationId !== "string") {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (value.operationId.trim().length === 0) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (typeof value.param !== "string" || value.param.trim().length === 0) {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (value.base !== "worker_working_directory") {
    throw invalidRuntimePathBinding(toolName, index);
  }
  if (value.default !== undefined && value.default !== ".") {
    throw invalidRuntimePathBinding(toolName, index);
  }
  const operationId = value.operationId.trim();
  const param = value.param.trim();
  const identity = `${operationId}\u0000${param}`;
  if (identities.has(identity)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (runtimePathBindings duplicate ${operationId}.${param})`,
    );
  }
  identities.add(identity);
  return Object.freeze({
    operationId,
    param,
    base: "worker_working_directory" as const,
    ...(value.default === "." ? { default: "." as const } : {}),
  });
}

function isRuntimePathBindingKey(key: string): boolean {
  if (key === "operationId") return true;
  if (key === "param") return true;
  if (key === "base") return true;
  return key === "default";
}

function invalidRuntimePathBinding(toolName: string, index: number): Error {
  return new Error(
    `Invalid tool definition for ${toolName} (runtimePathBindings.${index})`,
  );
}
