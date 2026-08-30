import { validateToolModuleDeclarations } from "../../capabilities/tool-definition-validator.js";
import type {
  CanonicalToolDefinitionDeclaration,
  ToolImplementation,
  ToolModuleDeclaration,
} from "../../capabilities/tool-types.js";
import type { ToolNormalInvocationContract } from "../../capabilities/normal-invocation/contracts.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import type { DiscoveredAgentPluginManifest } from "./discovered-manifest.js";
import {
  readAgentPluginSkills,
  resolveContainedPluginFile,
} from "./manifest-discovery.js";

const STATIC_VALIDATION_IMPLEMENTATION: ToolImplementation = async () => {
  throw new Error("Static plugin validation cannot execute capabilities");
};

export type ManifestCapabilityProjection = Readonly<{
  definition: CanonicalToolDefinitionDeclaration;
  normalInvocation: ToolNormalInvocationContract;
}>;

export type ManifestRuntimeProjection = Readonly<{
  entryPath: string;
  capabilities: readonly ManifestCapabilityProjection[];
  skills: Readonly<Record<string, string>>;
  capabilitySkills: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * Projects and validates the executable manifest contract without importing or
 * invoking plugin code. Runtime loading attaches handlers to this projection;
 * static catalog checks use the same normalized definitions directly.
 */
export function projectManifestRuntimeContract(
  discovered: DiscoveredAgentPluginManifest,
  selectedCapabilityIds: readonly string[],
): ManifestRuntimeProjection {
  const manifest = discovered.manifest;
  const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
  const capabilityIds = Object.keys(extension.capabilities);
  const selectedIds = new Set(selectedCapabilityIds);
  if (
    selectedIds.size !== selectedCapabilityIds.length ||
    selectedCapabilityIds.some(
      (capabilityId) => !capabilityIds.includes(capabilityId),
    )
  ) {
    throw new Error(
      `Runtime plugin ${manifest.name} selected capabilities are invalid`,
    );
  }

  const entryPath = resolveContainedPluginFile({
    pluginRoot: discovered.pluginRoot,
    configuredPath: extension.entrypoint,
    label: `Runtime plugin ${manifest.name} entrypoint`,
  });
  const selectedCapabilities = selectedCapabilityIds.map(
    (capabilityId) =>
      [capabilityId, extension.capabilities[capabilityId]!] as const,
  );
  const selectedSkillNames = new Set(
    selectedCapabilities.flatMap(([, capability]) => capability.skills),
  );
  const skills = readAgentPluginSkills(discovered, selectedSkillNames);
  const capabilitySkills: Record<string, readonly string[]> = {};
  const declarations: ToolModuleDeclaration[] = [];

  for (const [capabilityId, capability] of selectedCapabilities) {
    const referencedSkills = [...capability.skills];
    const unknownSkill = referencedSkills.find(
      (skillName) => !Object.prototype.hasOwnProperty.call(skills, skillName),
    );
    if (unknownSkill) {
      throw new Error(
        `Runtime plugin ${manifest.name} capability ${capabilityId} references unknown skill ${unknownSkill}`,
      );
    }
    if (referencedSkills.length > 0) {
      capabilitySkills[capabilityId] = referencedSkills;
    }
    declarations.push({
      definition: {
        name: capabilityId,
        description: capability.description,
        routingCapability: capability.routingCapability,
        ...(capability.controlsRefinement
          ? { controlsRefinement: capability.controlsRefinement }
          : {}),
        catalogGroups: [
          ...(capability.catalogGroups ??
            extension.catalogGroups ?? [manifest.name]),
        ],
        ...(capability.developmentRoles
          ? { developmentRoles: [...capability.developmentRoles] }
          : {}),
        ...(capability.eventPresentation
          ? { eventPresentation: capability.eventPresentation }
          : {}),
        ...(capability.payloadChannelSpec
          ? { payloadChannelSpec: capability.payloadChannelSpec }
          : {}),
        ...(capability.runtimePathBindings
          ? { runtimePathBindings: [...capability.runtimePathBindings] }
          : {}),
      },
      normalInvocation: {
        version: 1,
        operations: Object.entries(capability.operations).map(
          ([operationId, operation]) => ({
            operationId,
            summary: operation.summary,
            input: operation.input,
            ...(operation.selectionControlIds
              ? { selectionControlIds: operation.selectionControlIds }
              : {}),
            effect: operation.effect,
            approval: operation.approval,
            ...(operation.fixedParams
              ? { fixedParams: operation.fixedParams }
              : {}),
            ...(operation.payload ? { payload: operation.payload } : {}),
          }),
        ),
      },
      implementation: STATIC_VALIDATION_IMPLEMENTATION,
    });
  }

  const capabilities = validateToolModuleDeclarations(declarations).map(
    ({ definition, normalInvocation }) =>
      Object.freeze({ definition, normalInvocation }),
  );
  return Object.freeze({
    entryPath,
    capabilities: Object.freeze(capabilities),
    skills: Object.freeze({ ...skills }),
    capabilitySkills: Object.freeze(
      Object.fromEntries(
        Object.entries(capabilitySkills).map(([capabilityId, skillNames]) => [
          capabilityId,
          Object.freeze([...skillNames]),
        ]),
      ),
    ),
  });
}
