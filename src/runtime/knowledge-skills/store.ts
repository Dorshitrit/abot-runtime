export type KnowledgeSkillMetadata = Readonly<{
  skillId: string;
  name: string;
  description: string;
  source?: "system" | "personal";
}>;

export type KnowledgeSkillDocument = KnowledgeSkillMetadata &
  Readonly<{ content: string; revision?: number }>;

export interface KnowledgeSkillStore {
  list(): readonly KnowledgeSkillMetadata[];
  read(skillId: string): KnowledgeSkillDocument | undefined;
}

export const KNOWLEDGE_SKILL_ID_MAX_LENGTH = 128;
export const KNOWLEDGE_SKILL_READ_MAX_ITEMS = 8;

export function isKnowledgeSkillId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > KNOWLEDGE_SKILL_ID_MAX_LENGTH)
    return false;
  return value.trim() === value;
}

function hasKnowledgeSkillDocumentText(document: KnowledgeSkillDocument): boolean {
  if (typeof document.name !== "string" || !document.name.trim()) return false;
  if (typeof document.description !== "string" || !document.description.trim())
    return false;
  return typeof document.content === "string" && document.content.trim().length > 0;
}

/** An immutable document catalog. It has no role, plugin or context lifecycle. */
export function createKnowledgeSkillStore(
  definitions: readonly KnowledgeSkillDocument[],
): KnowledgeSkillStore {
  const documents = new Map<string, KnowledgeSkillDocument>();
  const metadata: KnowledgeSkillMetadata[] = [];
  for (const definition of definitions) {
    if (!isKnowledgeSkillId(definition.skillId))
      throw new Error("knowledge_skill_id_invalid");
    if (!hasKnowledgeSkillDocumentText(definition))
      throw new Error("knowledge_skill_document_invalid");
    if (documents.has(definition.skillId))
      throw new Error("knowledge_skill_id_duplicate");
    const entry = Object.freeze({
      skillId: definition.skillId,
      name: definition.name,
      description: definition.description,
    });
    metadata.push(entry);
    documents.set(
      entry.skillId,
      Object.freeze({ ...entry, content: definition.content }),
    );
  }
  const catalog = Object.freeze(metadata);
  return Object.freeze({
    list: () => catalog,
    read: (skillId: string) => documents.get(skillId),
  });
}
