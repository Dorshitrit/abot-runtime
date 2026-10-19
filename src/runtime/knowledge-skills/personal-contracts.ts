import type { KnowledgeSkillDocument, KnowledgeSkillStore } from "./store.js";

export const PERSONAL_SKILL_LIMITS = Object.freeze({ name: 160, description: 512, contentBytes: 64 * 1024,
  storeBytes: 16 * 1024 * 1024, revision: 2_147_483_647 });
export type PersonalSkillInput = Readonly<{ name: string; description: string; content: string }>;
export type PersonalSkillChanges = Readonly<{ name?: string; description?: string; content: string }>;
export type PersonalSkillDocument = KnowledgeSkillDocument & Readonly<{ source: "personal"; revision: number }>;
export type PersonalSkillRecord = PersonalSkillDocument & Readonly<{ archived: boolean }>;
export type PersonalSkillSummary = Omit<PersonalSkillRecord, "content">;
export interface PersonalSkillManagementService {
  list(): Promise<readonly PersonalSkillSummary[]>;
  get(skillId: string): Promise<PersonalSkillRecord | undefined>;
  create(input: PersonalSkillInput): Promise<PersonalSkillRecord>;
  updateContent(skillId: string, expectedRevision: number, content: string): Promise<PersonalSkillRecord>;
  archive(skillId: string, expectedRevision: number): Promise<PersonalSkillRecord>;
  restore(skillId: string, expectedRevision: number): Promise<PersonalSkillRecord>;
}
export interface WritableKnowledgeSkillStore extends KnowledgeSkillStore {
  create(input: PersonalSkillInput): Promise<PersonalSkillDocument>;
  update(skillId: string, expectedRevision: number, changes: PersonalSkillChanges): Promise<PersonalSkillDocument>;
}
export interface ManagedKnowledgeSkillStore extends WritableKnowledgeSkillStore {
  readonly personalSkills: PersonalSkillManagementService;
}

export function canWriteKnowledgeSkills(store: KnowledgeSkillStore): store is WritableKnowledgeSkillStore {
  const candidate = store as Partial<WritableKnowledgeSkillStore>;
  if (typeof candidate.create !== "function") return false;
  return typeof candidate.update === "function";
}

export function canManageKnowledgeSkills(store: KnowledgeSkillStore): store is ManagedKnowledgeSkillStore {
  if (!canWriteKnowledgeSkills(store)) return false;
  const service = (store as Partial<ManagedKnowledgeSkillStore>).personalSkills;
  if (!service || typeof service !== "object") return false;
  return [service.list, service.get, service.create, service.updateContent, service.archive, service.restore]
    .every((method) => typeof method === "function");
}

export class KnowledgeSkillError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function isKnowledgeSkillStorageFailure(error: unknown): error is KnowledgeSkillError {
  if (!(error instanceof KnowledgeSkillError)) return false;
  return ["knowledge_skill_storage_unavailable", "knowledge_skill_storage_invalid", "knowledge_skill_storage_too_large"].includes(error.code);
}
