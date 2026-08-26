import { isToolCatalogGroupId } from "../../../capabilities/tool-types.js";

import type { RoleCallWorkerCapabilityScope } from "./contracts.js";

export const ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT = 64;

export function parseRoleCallWorkerCapabilityScope(
  input: unknown,
): RoleCallWorkerCapabilityScope | undefined {
  if (!isRoleCallWorkerCapabilityScope(input)) return undefined;
  return Object.freeze({
    catalogGroupIds: Object.freeze([...input.catalogGroupIds]),
  });
}

export function isRoleCallWorkerCapabilityScope(
  input: unknown,
): input is RoleCallWorkerCapabilityScope {
  if (!isRecord(input) || !exactKeys(input, ["catalogGroupIds"])) {
    return false;
  }
  const catalogGroupIds = input.catalogGroupIds;
  return (
    Array.isArray(catalogGroupIds) &&
    catalogGroupIds.length > 0 &&
    catalogGroupIds.length <= ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT &&
    catalogGroupIds.every(isToolCatalogGroupId) &&
    new Set(catalogGroupIds).size === catalogGroupIds.length
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
