import { isToolCatalogGroupId } from "../../../capabilities/tool-types.js";
import type { ToolCatalogGroup } from "../../../capabilities/tool-types.js";
import {
  isRoleCapabilityId,
  parseRoleCallWorkerCapabilityScope,
} from "../role-calls/index.js";
import type {
  WorkerCapabilityDescriptor,
  WorkerCapabilityEffect,
} from "./contracts.js";

const WORKER_CAPABILITY_EFFECT_ORDER = Object.freeze([
  "observation",
  "mutation",
  "mixed",
] as const satisfies readonly WorkerCapabilityEffect[]);

export type WorkerCapabilityCatalogGroup = Readonly<{
  groupId: ToolCatalogGroup;
  memberCount: number;
  effects: readonly WorkerCapabilityEffect[];
}>;

export type WorkerCapabilityScopeProjection<T> = Readonly<{
  mode: "full" | "catalog_groups";
  catalogGroupIds: readonly ToolCatalogGroup[];
  knownCatalogGroupIds: readonly ToolCatalogGroup[];
  fullCapabilityIds: readonly string[];
  filteredCapabilityIds: readonly string[];
  entries: readonly T[];
}>;

export class WorkerCapabilityScopeError extends TypeError {
  readonly issueCode: string;

  constructor(issueCode: string) {
    super(`worker_capability_scope_rejected:${issueCode}`);
    this.name = "WorkerCapabilityScopeError";
    this.issueCode = issueCode;
  }
}

/**
 * Projects the manifest-owned group catalog once for both Planner routing and
 * Worker authorization. A capability contributes at most once to each group.
 */
export function projectWorkerCapabilityCatalogGroups(
  descriptors: readonly WorkerCapabilityDescriptor[],
): readonly WorkerCapabilityCatalogGroup[] {
  const normalized = normalizeScopeDescriptors(descriptors);
  return projectCatalogGroups(normalized);
}

/**
 * Applies the Worker call's canonical catalog-group scope as an OR union.
 * Input order is retained and a capability is returned at most once even when
 * it belongs to more than one selected group.
 */
export function projectWorkerCapabilityScope<T>(
  params: Readonly<{
    entries: readonly T[];
    scope?: unknown;
    descriptorOf(entry: T): WorkerCapabilityDescriptor;
  }>,
): WorkerCapabilityScopeProjection<T> {
  if (!Array.isArray(params.entries)) {
    throw new WorkerCapabilityScopeError("catalog_invalid");
  }
  const descriptors = normalizeScopeDescriptors(
    params.entries.map((entry) => params.descriptorOf(entry)),
  );
  const catalogGroups = projectCatalogGroups(descriptors);
  const knownCatalogGroupIds = Object.freeze(
    catalogGroups.map(({ groupId }) => groupId),
  );
  const fullCapabilityIds = Object.freeze(
    descriptors.map(({ capabilityId }) => capabilityId),
  );

  if (params.scope === undefined) {
    return Object.freeze({
      mode: "full" as const,
      catalogGroupIds: Object.freeze([]),
      knownCatalogGroupIds,
      fullCapabilityIds,
      filteredCapabilityIds: fullCapabilityIds,
      entries: Object.freeze([...params.entries]),
    });
  }

  const scope = parseRoleCallWorkerCapabilityScope(params.scope);
  if (!scope) {
    throw new WorkerCapabilityScopeError("scope_invalid");
  }
  const knownGroups = new Set(knownCatalogGroupIds);
  if (scope.catalogGroupIds.some((groupId) => !knownGroups.has(groupId))) {
    throw new WorkerCapabilityScopeError("catalog_group_unknown");
  }

  const requestedGroups = new Set(scope.catalogGroupIds);
  const entries: T[] = [];
  const filteredCapabilityIds: string[] = [];
  descriptors.forEach((descriptor, index) => {
    if (
      descriptor.catalogGroups!.some((groupId) => requestedGroups.has(groupId))
    ) {
      entries.push(params.entries[index]!);
      filteredCapabilityIds.push(descriptor.capabilityId);
    }
  });
  if (entries.length === 0) {
    throw new WorkerCapabilityScopeError("catalog_empty");
  }

  return Object.freeze({
    mode: "catalog_groups" as const,
    catalogGroupIds: Object.freeze([...scope.catalogGroupIds]),
    knownCatalogGroupIds,
    fullCapabilityIds,
    filteredCapabilityIds: Object.freeze(filteredCapabilityIds),
    entries: Object.freeze(entries),
  });
}

export function assertWorkerCapabilityWithinScope(
  projection: WorkerCapabilityScopeProjection<unknown>,
  descriptor: WorkerCapabilityDescriptor,
): void {
  if (!projection.filteredCapabilityIds.includes(descriptor.capabilityId)) {
    throw new WorkerCapabilityScopeError("capability_out_of_scope");
  }
  if (projection.mode === "full") return;
  const requestedGroups = new Set(projection.catalogGroupIds);
  const descriptorGroups = descriptor.catalogGroups ?? ["other"];
  if (!descriptorGroups.some((groupId) => requestedGroups.has(groupId))) {
    throw new WorkerCapabilityScopeError("capability_out_of_scope");
  }
}

function normalizeScopeDescriptors(
  input: readonly WorkerCapabilityDescriptor[],
): readonly WorkerCapabilityDescriptor[] {
  if (!Array.isArray(input)) {
    throw new WorkerCapabilityScopeError("catalog_invalid");
  }
  const seenCapabilityIds = new Set<string>();
  return Object.freeze(
    input.map((descriptor) => {
      if (
        typeof descriptor !== "object" ||
        descriptor === null ||
        Array.isArray(descriptor) ||
        !isRoleCapabilityId(descriptor.capabilityId) ||
        !isWorkerCapabilityEffect(descriptor.effect)
      ) {
        throw new WorkerCapabilityScopeError("descriptor_invalid");
      }
      if (seenCapabilityIds.has(descriptor.capabilityId)) {
        throw new WorkerCapabilityScopeError("duplicate_capability_id");
      }
      seenCapabilityIds.add(descriptor.capabilityId);
      const catalogGroups = descriptor.catalogGroups ?? ["other"];
      if (
        !Array.isArray(catalogGroups) ||
        catalogGroups.length === 0 ||
        new Set(catalogGroups).size !== catalogGroups.length ||
        catalogGroups.some((groupId) => !isToolCatalogGroupId(groupId))
      ) {
        throw new WorkerCapabilityScopeError(
          "descriptor_catalog_groups_invalid",
        );
      }
      return Object.freeze({
        ...descriptor,
        catalogGroups: Object.freeze([...catalogGroups]),
      });
    }),
  );
}

function projectCatalogGroups(
  descriptors: readonly WorkerCapabilityDescriptor[],
): readonly WorkerCapabilityCatalogGroup[] {
  const groups = new Map<
    ToolCatalogGroup,
    { memberCount: number; effects: Set<WorkerCapabilityEffect> }
  >();
  for (const descriptor of descriptors) {
    for (const groupId of descriptor.catalogGroups!) {
      const group = groups.get(groupId) ?? {
        memberCount: 0,
        effects: new Set<WorkerCapabilityEffect>(),
      };
      group.memberCount += 1;
      group.effects.add(descriptor.effect);
      groups.set(groupId, group);
    }
  }
  return Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([groupId, group]) =>
        Object.freeze({
          groupId,
          memberCount: group.memberCount,
          effects: Object.freeze(
            WORKER_CAPABILITY_EFFECT_ORDER.filter((effect) =>
              group.effects.has(effect),
            ),
          ),
        }),
      ),
  );
}

function isWorkerCapabilityEffect(
  input: unknown,
): input is WorkerCapabilityEffect {
  return input === "observation" || input === "mutation" || input === "mixed";
}
