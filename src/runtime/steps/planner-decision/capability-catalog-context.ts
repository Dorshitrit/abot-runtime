import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ToolCatalogGroup } from "../../../capabilities/tool-types.js";
import type { RequestContextPinnedPart } from "../../context/request-context-contracts.js";
import {
  projectWorkerCapabilityCatalogGroups,
  type WorkerCapabilityCatalogGroup,
  type WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";

export const PLANNER_WORKER_CAPABILITY_CATALOG_KIND =
  "runtime_planner_worker_capability_catalog_v1" as const;

export type PlannerWorkerCapabilityCatalogGroup = Readonly<
  WorkerCapabilityCatalogGroup & { description: string }
>;

export function projectPlannerWorkerCapabilityCatalogGroups(
  descriptors: readonly WorkerCapabilityDescriptor[],
): readonly PlannerWorkerCapabilityCatalogGroup[] {
  const catalogGroups = projectWorkerCapabilityCatalogGroups(descriptors);
  return Object.freeze(
    catalogGroups
      .map((group) =>
        Object.freeze({
          ...group,
          description: describeCatalogGroup(group.groupId, descriptors),
        }),
      )
      .sort((left, right) => compareAscii(left.groupId, right.groupId)),
  );
}

export function buildPlannerReferenceParts(
  params: Readonly<{
    callId: string;
    invocationAttempt: number;
    exactMessages: readonly ChatMessage[];
    catalogGroups: readonly PlannerWorkerCapabilityCatalogGroup[];
  }>,
): readonly RequestContextPinnedPart[] {
  const exactPart = Object.freeze({
    sourceRef: `planner-reference:${params.callId}:${params.invocationAttempt}`,
    category: "request_reference" as const,
    retention: "exact" as const,
    messages: params.exactMessages,
  });
  if (params.catalogGroups.length === 0) return Object.freeze([exactPart]);
  return Object.freeze([
    exactPart,
    Object.freeze({
      sourceRef: [
        "planner-worker-capability-catalog",
        params.callId,
        String(params.invocationAttempt),
      ].join(":"),
      category: "request_reference" as const,
      retention: "compactable" as const,
      messages: Object.freeze([
        buildCatalogMessage("detailed", params.catalogGroups),
      ]),
      compactMessages: Object.freeze([
        buildCatalogMessage("compact", params.catalogGroups),
      ]),
    }),
  ]);
}

function buildCatalogMessage(
  projection: "detailed" | "compact",
  catalogGroups: readonly PlannerWorkerCapabilityCatalogGroup[],
): ChatMessage {
  const capsule =
    projection === "compact"
      ? {
          kind: PLANNER_WORKER_CAPABILITY_CATALOG_KIND,
          authority: "runtime_registry",
          presenceEffect: "passive_not_user_intent",
          projection,
          catalogGroups,
        }
      : {
          kind: PLANNER_WORKER_CAPABILITY_CATALOG_KIND,
          authority: "runtime_registry",
          presenceEffect:
            "passive_worker_routing_metadata_not_user_intent_or_execution_authority",
          applicability: "planner_worker_invoke_role_group_routing_only",
          lifetime: "request_role_call_projection_only",
          projection,
          scopeSemantics: {
            groupCombination: "or_union",
            scopeEffect: "narrows_worker_catalog_only",
            capabilitySelection: "worker_owned",
          },
          catalogGroups,
        };
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify(capsule),
  });
}

function describeCatalogGroup(
  groupId: ToolCatalogGroup,
  descriptors: readonly WorkerCapabilityDescriptor[],
): string {
  const members = descriptors.filter((descriptor) =>
    (descriptor.catalogGroups ?? ["other"]).includes(groupId),
  );
  const routingCapabilities = [
    ...new Set(
      members.flatMap(({ routingCapability }) =>
        routingCapability ? [routingCapability] : [],
      ),
    ),
  ].sort(compareAscii);
  const developmentRoles = [
    ...new Set(members.flatMap(({ developmentRoles: roles }) => roles ?? [])),
  ].sort(compareAscii);
  return [
    `routingCapabilities=${routingCapabilities.join(",")}`,
    `developmentRoles=${developmentRoles.join(",")}`,
  ].join("\n");
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
