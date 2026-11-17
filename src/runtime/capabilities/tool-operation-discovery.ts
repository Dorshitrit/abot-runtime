import type { ToolRegistry } from "../ports.js";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { ToolCapabilityDiscovery } from "../../capabilities/tool-request-discovery.js";
import { validateToolModuleDeclarations } from "../../capabilities/tool-definition-validator.js";
import { prepareRequestToolModules } from "./request-module-preparation.js";

/** Catalog consumers receive metadata, never permission to execute unbound handlers. */
export async function discoverToolOperations(registry: ToolRegistry) {
  if (registry.discoverOperations) return registry.discoverOperations();
  const prepared = await registry.prepareRequest?.() ?? registry;
  return prepared.listNormalInvocations?.() ?? [];
}

export async function discoverToolModules(
  modules: readonly ToolModuleDeclaration[],
): Promise<readonly ToolModuleDeclaration[]> {
  const selected = validateToolModuleDeclarations(modules);
  const ordinary = await prepareRequestToolModules(
    selected.filter((module) => !module.definition.requiresRequestBinding),
  );
  const available = new Map(ordinary.map((module) => [module.definition.name, module]));
  const groups = new Map<ToolCapabilityDiscovery, ToolModuleDeclaration[]>();
  for (const module of selected) {
    if (!module.definition.requiresRequestBinding) continue;
    if (!module.discoverCapabilities) continue;
    const group = groups.get(module.discoverCapabilities) ?? [];
    group.push(module);
    groups.set(module.discoverCapabilities, group);
  }
  await Promise.all([...groups].map(async ([discover, group]) => {
    const metadata = group.map(({ definition, normalInvocation }) => Object.freeze({
      definition: structuredClone(definition), normalInvocation: structuredClone(normalInvocation),
    }));
    const names = await discover(Object.freeze(metadata));
    assertDiscoveredNamesAreSelected(group, names);
    const namesSet = new Set(names);
    for (const module of group) {
      if (namesSet.has(module.definition.name)) available.set(module.definition.name, module);
    }
  }));
  return selected.flatMap((module) => {
    const discovered = available.get(module.definition.name);
    return discovered ? [discovered] : [];
  });
}

function assertDiscoveredNamesAreSelected(selected: readonly ToolModuleDeclaration[], names: readonly string[]) {
  if (!Array.isArray(names)) throw new Error("Operation discovery must return selected capability names");
  const allowed = new Set(selected.map((module) => module.definition.name));
  for (const name of names) {
    if (!allowed.delete(name)) throw new Error("Operation discovery returned an unselected or duplicate capability");
  }
}
