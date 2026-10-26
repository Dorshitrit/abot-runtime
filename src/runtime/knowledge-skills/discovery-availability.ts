import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { KnowledgeSkillMetadata, KnowledgeSkillOperationReference, KnowledgeSkillStore } from "./store.js";

/** Definition metadata remains internal and immutable; LIST/READ contain no discovery policy. */
export function snapshotSkillDiscoveryRequirements(
  operations: readonly KnowledgeSkillOperationReference[] | undefined,
): readonly KnowledgeSkillOperationReference[] | undefined {
  if (operations === undefined) return undefined;
  if (!Array.isArray(operations)) throw new Error("knowledge_skill_discovery_requirement_invalid");
  return Object.freeze(operations.map(operation => {
    if (!isSkillOperationReference(operation)) throw new Error("knowledge_skill_discovery_requirement_invalid");
    return Object.freeze({ toolName: operation.toolName, operationId: operation.operationId });
  }));
}

function isSkillOperationReference(value: unknown): value is KnowledgeSkillOperationReference {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<KnowledgeSkillOperationReference>;
  if (typeof operation.toolName !== "string" || !operation.toolName.trim()) return false;
  return typeof operation.operationId === "string" && operation.operationId.trim().length > 0;
}

function skillOperationKey(operation: KnowledgeSkillOperationReference): string {
  return JSON.stringify([operation.toolName, operation.operationId]);
}

function hasRequiredSkillOperations(
  requirements: readonly KnowledgeSkillOperationReference[] | undefined,
  available: ReadonlySet<string>,
): boolean {
  if (!requirements) return true;
  return requirements.every(operation => available.has(skillOperationKey(operation)));
}

/** Both root contracts use the prepared request catalog, without reads or live availability I/O. */
export function projectDiscoverableSkills(
  store: KnowledgeSkillStore,
  tools: readonly ToolAvailabilityEntry[] = [],
): readonly KnowledgeSkillMetadata[] {
  const available = new Set(tools.map(skillOperationKey));
  return store.list()
    .filter(({ skillId }) => hasRequiredSkillOperations(store.getDiscoveryRequirements?.(skillId), available))
    .map(({ skillId, name, description }) => ({ skillId, name, description }));
}
