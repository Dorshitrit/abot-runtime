import { Buffer } from "node:buffer";
import { KnowledgeSkillError, PERSONAL_SKILL_LIMITS, type PersonalSkillDocument, type PersonalSkillInput, type PersonalSkillRecord } from "./personal-contracts.js";

function hasBoundedSkillText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.length <= maxLength;
}

export function validatePersonalSkillInput(input: PersonalSkillInput): PersonalSkillInput {
  if (!hasBoundedSkillText(input.name, PERSONAL_SKILL_LIMITS.name))
    throw new KnowledgeSkillError("knowledge_skill_name_invalid");
  if (!hasBoundedSkillText(input.description, PERSONAL_SKILL_LIMITS.description))
    throw new KnowledgeSkillError("knowledge_skill_description_invalid");
  if (typeof input.content !== "string" || !input.content.trim())
    throw new KnowledgeSkillError("knowledge_skill_content_invalid");
  if (Buffer.byteLength(input.content, "utf8") > PERSONAL_SKILL_LIMITS.contentBytes)
    throw new KnowledgeSkillError("knowledge_skill_content_too_large");
  return { name: input.name.trim(), description: input.description.trim(), content: input.content };
}

export function isPersonalSkillRevision(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return value >= 1 && value <= PERSONAL_SKILL_LIMITS.revision;
}

function parsePersonalSkillRecord(value: unknown, schemaVersion: 1 | 2): PersonalSkillRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  const document = value as PersonalSkillRecord;
  if (typeof document.skillId !== "string" || !/^personal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(document.skillId))
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  if (document.source !== "personal" || !isPersonalSkillRevision(document.revision))
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  if (schemaVersion === 2 && typeof document.archived !== "boolean")
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  const content = validatePersonalSkillInput(document);
  return Object.freeze({ ...content, skillId: document.skillId, source: "personal", revision: document.revision,
    archived: schemaVersion === 2 ? document.archived : false });
}

export function parsePersonalSkillSnapshot(value: unknown): readonly PersonalSkillRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  const state = value as { schemaVersion?: unknown; skills?: unknown };
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2)
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  if (!Array.isArray(state.skills))
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  const schemaVersion = state.schemaVersion;
  const documents = state.skills.map((skill) => parsePersonalSkillRecord(skill, schemaVersion));
  if (new Set(documents.map(({ skillId }) => skillId)).size !== documents.length)
    throw new KnowledgeSkillError("knowledge_skill_storage_invalid");
  return Object.freeze(documents);
}

/** Archive state belongs to management and persistence, never model-facing documents. */
export function projectPersonalSkillDocument(record: PersonalSkillRecord): PersonalSkillDocument {
  const { archived: _archived, ...document } = record;
  return Object.freeze(document);
}
