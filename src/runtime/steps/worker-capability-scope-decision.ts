import {
  ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT,
  parseRoleCallWorkerCapabilityScope,
  type RoleCallWorkerCapabilityScope,
} from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityCatalogGroup } from "../orchestration/worker-capabilities/index.js";

export type WorkerCapabilityScopeDecisionContract = Readonly<{
  catalogGroupIds: readonly string[];
  required: boolean;
  schema?: Record<string, unknown>;
}>;

export function createWorkerCapabilityScopeDecisionContract(
  availableCatalog: readonly WorkerCapabilityCatalogGroup[],
): WorkerCapabilityScopeDecisionContract {
  const catalogGroupIds = Object.freeze(
    availableCatalog.map((group) => group.groupId),
  );
  if (catalogGroupIds.length === 0) {
    return Object.freeze({ catalogGroupIds, required: false });
  }
  return Object.freeze({
    catalogGroupIds,
    required: true,
    schema: {
      type: "object",
      properties: {
        catalogGroupIds: {
          type: "array",
          minItems: 1,
          maxItems: Math.min(
            catalogGroupIds.length,
            ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT,
          ),
          items: {
            type: "string",
            enum: [...catalogGroupIds],
          },
        },
      },
      required: ["catalogGroupIds"],
      additionalProperties: false,
    },
  });
}

export function parseWorkerCapabilityScopeDecision(
  input: unknown,
  contract: WorkerCapabilityScopeDecisionContract,
): RoleCallWorkerCapabilityScope | undefined {
  if (!contract.required) return undefined;
  if (!hasWorkerCapabilityGroupList(input)) return undefined;
  // Normalize model selections; canonical scopes remain strictly unique.
  const parsed = parseRoleCallWorkerCapabilityScope({
    ...input,
    catalogGroupIds: [...new Set(input.catalogGroupIds)],
  });
  if (
    !parsed ||
    parsed.catalogGroupIds.length > contract.catalogGroupIds.length ||
    parsed.catalogGroupIds.some(
      (groupId) => !contract.catalogGroupIds.includes(groupId),
    )
  ) {
    return undefined;
  }
  return parsed;
}

function hasWorkerCapabilityGroupList(
  input: unknown,
): input is Record<string, unknown> & { catalogGroupIds: unknown[] } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return (
    Object.hasOwn(input, "catalogGroupIds") &&
    Array.isArray((input as Record<string, unknown>).catalogGroupIds)
  );
}
