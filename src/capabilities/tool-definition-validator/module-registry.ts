import type {
  ToolCallAdapter,
  ToolModule,
  ToolModuleDeclaration,
} from "../tool-types.js";
import { projectNormalInvocationDefinition } from "../normal-invocation/definition-projection.js";
import {
  parseToolNormalInvocationContract,
  parseToolNormalInvocationForDefinition,
} from "../normal-invocation/validator.js";
import { parseToolDefinition } from "./definition-parser.js";
import {
  isToolDefinitionRecordValue,
  readToolDefinitionName,
} from "./definition-shape.js";

export function buildToolRegistry(
  modules: readonly ToolModuleDeclaration[],
): ToolModule[] {
  if (!Array.isArray(modules)) {
    throw new Error("Tool registry modules must be an array");
  }

  const seenNames = new Set<string>();
  return modules.map((module, index) => {
    if (!module || typeof module !== "object") {
      throw new Error(`Invalid tool module entry at index ${index}`);
    }
    const rawDefinition = module.definition as unknown;
    const toolName = readToolDefinitionName(rawDefinition);
    const parsedNormalInvocation = parseToolNormalInvocationContract(
      toolName,
      module.normalInvocation,
    );
    if (!parsedNormalInvocation) {
      throw new Error(
        `Invalid tool module for ${toolName} (normalInvocation is required)`,
      );
    }
    const definition = parseToolDefinition(
      projectCanonicalDefinition({
        toolName,
        rawDefinition,
        normalInvocation: parsedNormalInvocation,
      }),
    );
    if (seenNames.has(definition.name)) {
      throw new Error(`Duplicate tool definition: ${definition.name}`);
    }
    seenNames.add(definition.name);
    if (typeof module.implementation !== "function") {
      throw new Error(
        `Invalid tool module for ${definition.name} (implementation)`,
      );
    }
    const adapter = parseToolAdapter(definition.name, module.adapter);
    const normalInvocation = parseToolNormalInvocationForDefinition(
      definition,
      parsedNormalInvocation,
    );
    return {
      definition,
      implementation: module.implementation,
      ...(adapter ? { adapter } : {}),
      normalInvocation: normalInvocation!,
    };
  });
}

export function validateToolModuleDeclarations(
  modules: readonly ToolModuleDeclaration[],
): ToolModuleDeclaration[] {
  const resolved = buildToolRegistry(modules);
  return resolved.map((tool, index) => {
    const source = modules[index]!;
    const {
      params: _projectedParams,
      executionEffect: _projectedEffect,
      ...definition
    } = tool.definition;
    void _projectedParams;
    void _projectedEffect;
    return {
      definition,
      implementation: tool.implementation,
      ...(tool.adapter ? { adapter: tool.adapter } : {}),
      normalInvocation: tool.normalInvocation,
    };
  });
}

function parseToolAdapter(
  toolName: string,
  raw: unknown,
): ToolCallAdapter | undefined {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error(`Invalid tool module for ${toolName} (adapter)`);
  }
  const normalizeCall = raw.normalizeCall;
  const validateCall = raw.validateCall;
  if (normalizeCall !== undefined && typeof normalizeCall !== "function") {
    throw new Error(
      `Invalid tool module for ${toolName} (adapter.normalizeCall)`,
    );
  }
  if (validateCall !== undefined && typeof validateCall !== "function") {
    throw new Error(
      `Invalid tool module for ${toolName} (adapter.validateCall)`,
    );
  }
  const adapter: ToolCallAdapter = {};
  if (typeof normalizeCall === "function") {
    adapter.normalizeCall = normalizeCall as ToolCallAdapter["normalizeCall"];
  }
  if (typeof validateCall === "function") {
    adapter.validateCall = validateCall as ToolCallAdapter["validateCall"];
  }
  return adapter;
}

function projectCanonicalDefinition(params: {
  toolName: string;
  rawDefinition: unknown;
  normalInvocation: NonNullable<ToolModule["normalInvocation"]>;
}): Record<string, unknown> {
  if (!isToolDefinitionRecordValue(params.rawDefinition)) {
    throw new Error("Invalid tool definition entry (not an object)");
  }
  if (params.rawDefinition.params !== undefined) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (params must be omitted when normalInvocation is canonical)`,
    );
  }
  if (params.rawDefinition.executionEffect !== undefined) {
    throw new Error(
      `Invalid tool definition for ${params.toolName} (executionEffect must be omitted when normalInvocation is canonical)`,
    );
  }
  const projection = projectNormalInvocationDefinition({
    toolName: params.toolName,
    contract: params.normalInvocation,
  });
  return {
    ...params.rawDefinition,
    params: { ...projection.params },
    executionEffect: projection.executionEffect,
  };
}
