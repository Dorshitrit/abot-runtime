import type { ToolRequestPreparationContext } from "../../capabilities/tool-request-resources.js";
import { isDeepStrictEqual } from "node:util";
import type {
  ToolModuleDeclaration,
  ToolModuleRequestPreparation,
} from "../../capabilities/tool-types.js";
import type { ToolNormalInvocationOperation } from "../../capabilities/normal-invocation/contracts.js";
import { validateToolModuleDeclarations } from "../../capabilities/tool-definition-validator.js";
import { isNarrowedInputProperty } from "./request-property-narrowing.js";

/** Config selection precedes observation. A plugin may narrow, never add authority. */
export async function prepareRequestToolModules(
  modules: readonly ToolModuleDeclaration[],
  context?: ToolRequestPreparationContext,
): Promise<readonly ToolModuleDeclaration[]> {
  const selectedModules = validateToolModuleDeclarations(modules);
  const groups = new Map<
    ToolModuleRequestPreparation,
    ToolModuleDeclaration[]
  >();
  for (const module of selectedModules) {
    if (!module.prepareRequest) continue;
    const selected = groups.get(module.prepareRequest) ?? [];
    selected.push(module);
    groups.set(module.prepareRequest, selected);
  }
  const prepared = new Map<string, ToolModuleDeclaration>();
  await Promise.all(
    [...groups].map(async ([prepare, selected]) => {
      const inputs = Object.freeze(selected.map(captureSelectedModule));
      const output = validateToolModuleDeclarations(
        await prepare(inputs, context),
      );
      assertPreparedAuthorityIsNarrowed(selected, output);
      for (const module of output) {
        const { prepareRequest: _prepare, ...bound } = module;
        prepared.set(module.definition.name, bound);
      }
    }),
  );
  return selectedModules.flatMap((module) => {
    if (!module.prepareRequest) return [module];
    const bound = prepared.get(module.definition.name);
    return bound ? [bound] : [];
  });
}

function captureSelectedModule(
  module: ToolModuleDeclaration,
): ToolModuleDeclaration {
  return Object.freeze({
    definition: freezeContract(structuredClone(module.definition)),
    normalInvocation: freezeContract(structuredClone(module.normalInvocation)),
    implementation: module.implementation,
    ...(module.adapter
      ? { adapter: Object.freeze({ ...module.adapter }) }
      : {}),
  });
}

function freezeContract<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) freezeContract(child);
  return Object.freeze(value);
}

function assertPreparedAuthorityIsNarrowed(
  selected: readonly ToolModuleDeclaration[],
  prepared: readonly ToolModuleDeclaration[],
): void {
  const byName = new Map(
    selected.map((module) => [module.definition.name, module]),
  );
  for (const module of prepared) {
    const source = byName.get(module.definition.name);
    if (!source)
      throw new Error("Request preparation returned an unselected tool");
    if (!isDeepStrictEqual(source.definition, module.definition)) {
      throw new Error(
        `Request preparation changed tool authority: ${module.definition.name}`,
      );
    }
    if (source.normalInvocation.version !== module.normalInvocation.version) {
      throw new Error("Request preparation changed invocation version");
    }
    const operations = new Map(
      source.normalInvocation.operations.map((operation) => [
        operation.operationId,
        operation,
      ]),
    );
    for (const operation of module.normalInvocation.operations) {
      const original = operations.get(operation.operationId);
      if (!original)
        throw new Error("Request preparation returned an undeclared operation");
      assertOperationAuthorityIsNarrowed(original, operation);
    }
  }
}

function assertOperationAuthorityIsNarrowed(
  original: ToolNormalInvocationOperation,
  prepared: ToolNormalInvocationOperation,
): void {
  const {
    summary: _summary,
    input: originalInput,
    ...originalAuthority
  } = original;
  const {
    summary: _preparedSummary,
    input: preparedInput,
    ...preparedAuthority
  } = prepared;
  if (!isDeepStrictEqual(originalAuthority, preparedAuthority)) {
    throw new Error(
      `Request preparation changed operation authority: ${original.operationId}`,
    );
  }
  const { properties: originalProperties, ...originalShape } = originalInput;
  const { properties: preparedProperties, ...preparedShape } = preparedInput;
  if (!isDeepStrictEqual(originalShape, preparedShape)) {
    throw new Error("Request preparation changed input shape");
  }
  if (
    !isDeepStrictEqual(
      Object.keys(originalProperties).sort(),
      Object.keys(preparedProperties).sort(),
    )
  ) {
    throw new Error("Request preparation changed input controls");
  }
  for (const [name, property] of Object.entries(preparedProperties)) {
    if (!isNarrowedInputProperty(originalProperties[name]!, property)) {
      throw new Error(`Request preparation widened input control: ${name}`);
    }
  }
}
