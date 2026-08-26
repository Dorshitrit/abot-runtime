import type { ToolCatalogGroup } from "../../../capabilities/tool-types.js";
import type {
  WorkerCapabilityDescriptor,
  WorkerCapabilityEffect,
} from "../worker-capabilities/contracts.js";
import {
  projectWorkerCapabilityScope,
  type WorkerCapabilityScopeProjection,
} from "../worker-capabilities/scope.js";

export const CAPABILITY_CATALOG_GROUP_COUNT_MAX = 64;

export type CapabilityCatalogGroup = Readonly<{
  groupId: ToolCatalogGroup;
  description: string;
  memberCount: number;
  effects: readonly WorkerCapabilityEffect[];
}>;

const EFFECT_ORDER = Object.freeze([
  "observation",
  "mutation",
  "mixed",
] as const satisfies readonly WorkerCapabilityEffect[]);

/** Builds routing text mechanically from every exact group member. */
export function projectCapabilityCatalogGroups(
  descriptors: readonly WorkerCapabilityDescriptor[],
): readonly CapabilityCatalogGroup[] {
  const normalized = projectWorkerCapabilityScope({
    entries: descriptors,
    descriptorOf: (entry) => entry,
  });
  const groups = new Map<
    ToolCatalogGroup,
    {
      members: Array<Readonly<{ capabilityId: string; summary: string }>>;
      effects: Set<WorkerCapabilityEffect>;
    }
  >();
  for (const descriptor of normalized.entries) {
    for (const groupId of descriptor.catalogGroups ?? ["other"]) {
      const group = groups.get(groupId) ?? {
        members: [],
        effects: new Set<WorkerCapabilityEffect>(),
      };
      group.members.push({
        capabilityId: descriptor.capabilityId,
        summary: descriptor.summary,
      });
      group.effects.add(descriptor.effect);
      groups.set(groupId, group);
    }
  }
  if (groups.size > CAPABILITY_CATALOG_GROUP_COUNT_MAX) {
    throw new TypeError("capability_scope_rejected:catalog_group_limit");
  }
  return Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => compareAscii(left, right))
      .map(([groupId, group]) => {
        const members = [...group.members].sort((left, right) =>
          compareAscii(left.capabilityId, right.capabilityId),
        );
        return Object.freeze({
          groupId,
          description: members
            .map(({ capabilityId, summary }) => `${capabilityId}: ${summary}`)
            .join("\n"),
          memberCount: members.length,
          effects: Object.freeze(
            EFFECT_ORDER.filter((effect) => group.effects.has(effect)),
          ),
        });
      }),
  );
}

export function projectCapabilityScope<T>(
  params: Readonly<{
    entries: readonly T[];
    scope?: unknown;
    descriptorOf(entry: T): WorkerCapabilityDescriptor;
  }>,
): WorkerCapabilityScopeProjection<T> {
  return projectWorkerCapabilityScope(params);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
