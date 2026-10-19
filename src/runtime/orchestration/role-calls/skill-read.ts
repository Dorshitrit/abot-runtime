import { Buffer } from "node:buffer";
import { PERSONAL_SKILL_LIMITS } from "../../knowledge-skills/personal-contracts.js";
import {
  isKnowledgeSkillId, KNOWLEDGE_SKILL_ID_MAX_LENGTH, KNOWLEDGE_SKILL_READ_MAX_ITEMS,
  type KnowledgeSkillDocument, type KnowledgeSkillMetadata,
} from "../../knowledge-skills/store.js";
import type {
  RoleCallPolicy, RoleCallState, RoleCallValidationIssue,
} from "./contracts.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";

export type RoleSkillReadResult<T> =
  | Readonly<{ outcome: "completed"; skills: readonly T[] }>
  | Readonly<{ outcome: "failed"; errorCode: string; skills: readonly [] }>;

export type RoleSkillReadPayload =
  | Readonly<{
      operation: "list_skills";
      selectors: readonly [];
      result: RoleSkillReadResult<KnowledgeSkillMetadata>;
    }>
  | Readonly<{
      operation: "read_skills";
      selectors: readonly string[];
      result: RoleSkillReadResult<KnowledgeSkillDocument>;
    }>;

type RoleSkillReadBinding = Readonly<{
  callId: string;
  invocationAttempt: number;
  steeringVersion: number;
}>;

export type RoleSkillRead = RoleSkillReadBinding & RoleSkillReadPayload &
  Readonly<{ readId: string }>;

export type RecordRoleSkillReadCommand = RoleSkillReadBinding &
  RoleSkillReadPayload & Readonly<{
    authority: "runtime";
    type: "record_skill_read";
  }>;

export type RoleSkillReadCommitEffect = RoleSkillReadBinding & Readonly<{
  type: "skill_read_recorded";
  readId: string;
  operation: RoleSkillReadPayload["operation"];
}>;

/** Decode the exact Store snapshots supplied by the runtime read boundary. */
export function decodeSkillReadCommand(input: Record<string, unknown>):
  | Readonly<{ ok: true; value: RecordRoleSkillReadCommand }>
  | Readonly<{ ok: false; code: "invalid_command" }> {
  const isRuntimeReadCommand =
    input.authority === "runtime" && input.type === "record_skill_read";
  if (!isRuntimeReadCommand) return { ok: false, code: "invalid_command" };
  const hasCommandFields = exactKeys(input, [
    "authority", "type", "callId", "invocationAttempt", "steeringVersion",
    "operation", "selectors", "result",
  ]);
  if (!hasCommandFields) return { ok: false, code: "invalid_command" };
  if (!hasSkillReadBinding(input)) return { ok: false, code: "invalid_command" };
  if (!hasSkillReadPayload(input)) return { ok: false, code: "invalid_command" };
  return { ok: true, value: input as RecordRoleSkillReadCommand };
}

/** Omission preserves heads and parked requests created before core Skill reads. */
export function validateRoleSkillReads(
  state: RoleCallState, policy: RoleCallPolicy,
): readonly RoleCallValidationIssue[] {
  const reads = state.skillReads;
  if (reads === undefined) return [];
  const invalid = [{ code: "invalid_role_skill_reads", path: "state.skillReads" }];
  if (!Array.isArray(reads)) return invalid;
  if (reads.length === 0) return [];
  const usesSupervisorContract = policy.authority.rootContractId === "supervisor";
  if (!usesSupervisorContract) return invalid;
  const root = state.calls.find((call) => call.callId === state.rootCallId);
  if (!root) return invalid;
  const isSupervisorRoot = root.parentCallId === null && root.roleId === "supervisor";
  if (!isSupervisorRoot) return invalid;
  let previousAttempt = 0;
  let previousSteeringVersion = 0;
  for (const [index, read] of reads.entries()) {
    if (!isRecord(read)) return invalid;
    const hasReceiptFields = exactKeys(read, [
      "readId", "callId", "invocationAttempt", "steeringVersion",
      "operation", "selectors", "result",
    ]);
    if (!hasReceiptFields) return invalid;
    if (!hasSkillReadBinding(read)) return invalid;
    if (!hasSkillReadPayload(read)) return invalid;
    const hasSequentialIdentity = read.readId === `skill-read-${index + 1}`;
    if (!hasSequentialIdentity) return invalid;
    const belongsToRoot = read.callId === root.callId;
    if (!belongsToRoot) return invalid;
    const followsPreviousRead = read.invocationAttempt > previousAttempt;
    if (!followsPreviousRead) return invalid;
    const precedesCurrentActivation = read.invocationAttempt < root.activationCount;
    if (!precedesCurrentActivation) return invalid;
    const preservesSteeringOrder = read.steeringVersion >= previousSteeringVersion;
    if (!preservesSteeringOrder) return invalid;
    previousAttempt = read.invocationAttempt;
    previousSteeringVersion = read.steeringVersion;
  }
  return [];
}

function hasSkillReadBinding(value: Record<string, unknown>): value is
  Record<string, unknown> & RoleSkillReadBinding {
  if (!hasText(value.callId)) return false;
  const hasInvocationAttempt =
    Number.isSafeInteger(value.invocationAttempt) &&
    (value.invocationAttempt as number) >= 1;
  if (!hasInvocationAttempt) return false;
  const hasSteeringVersion =
    Number.isSafeInteger(value.steeringVersion) &&
    (value.steeringVersion as number) >= 0;
  return hasSteeringVersion;
}

function hasSkillReadPayload(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.selectors)) return false;
  if (!isRecord(value.result)) return false;
  const selectors = value.selectors;
  const isRead = value.operation === "read_skills";
  const isList = value.operation === "list_skills";
  if (!isRead && !isList) return false;
  if (isRead && !hasValidSelectors(selectors)) return false;
  if (isList && selectors.length !== 0) return false;
  const result = value.result;
  if (!Array.isArray(result.skills)) return false;
  if (result.outcome === "failed") {
    const hasFailureFields = exactKeys(result, ["outcome", "errorCode", "skills"]);
    if (!hasFailureFields) return false;
    if (typeof result.errorCode !== "string") return false;
    const hasErrorCode = /^[a-z][a-z0-9_]*$/.test(result.errorCode);
    if (!hasErrorCode) return false;
    return result.skills.length === 0;
  }
  if (result.outcome !== "completed") return false;
  if (!exactKeys(result, ["outcome", "skills"])) return false;
  const hasReadSize =
    result.skills.length > 0 &&
    result.skills.length <= KNOWLEDGE_SKILL_READ_MAX_ITEMS;
  if (isRead && !hasReadSize) return false;
  if (!result.skills.every((skill) => hasSkillSnapshot(skill, isRead))) return false;
  const skills = result.skills as readonly KnowledgeSkillDocument[];
  const hasUniqueSkills = new Set(skills.map(({ skillId }) => skillId)).size === skills.length;
  if (!hasUniqueSkills) return false;
  if (!isRead) return true;
  const resolvesEverySelector = selectors.every((selector) =>
    skills.some((skill) => matchesSelector(skill, selector)));
  if (!resolvesEverySelector) return false;
  const containsOnlySelectedSkills = skills.every((skill) =>
    selectors.some((selector) => matchesSelector(skill, selector)));
  return containsOnlySelectedSkills;
}

function hasValidSelectors(values: readonly unknown[]): values is readonly string[] {
  const hasReadSize = values.length > 0 && values.length <= KNOWLEDGE_SKILL_READ_MAX_ITEMS;
  if (!hasReadSize) return false;
  const maximumLength = Math.max(KNOWLEDGE_SKILL_ID_MAX_LENGTH, PERSONAL_SKILL_LIMITS.name);
  const hasExactSelectors = values.every((value) => {
    if (typeof value !== "string") return false;
    const hasBoundedLength = value.length > 0 && value.length <= maximumLength;
    if (!hasBoundedLength) return false;
    return value.trim() === value;
  });
  if (!hasExactSelectors) return false;
  return new Set(values).size === values.length;
}

function matchesSelector(skill: KnowledgeSkillMetadata, selector: unknown): boolean {
  return skill.skillId === selector || skill.name === selector;
}

function hasSkillSnapshot(value: unknown, document: boolean): boolean {
  if (!isRecord(value)) return false;
  const hasSnapshotFields = exactKeys(value,
    ["skillId", "name", "description", ...(document ? ["content"] : [])],
    ["source", ...(document ? ["revision"] : [])]);
  if (!hasSnapshotFields) return false;
  if (!isKnowledgeSkillId(value.skillId)) return false;
  if (!hasText(value.name)) return false;
  if (!hasText(value.description)) return false;
  const hasKnownSource =
    value.source === undefined || value.source === "system" || value.source === "personal";
  if (!hasKnownSource) return false;
  if (value.revision !== undefined) {
    const hasValidRevision =
      Number.isSafeInteger(value.revision) &&
      (value.revision as number) >= 1 &&
      (value.revision as number) <= PERSONAL_SKILL_LIMITS.revision;
    if (!hasValidRevision) return false;
  }
  if (document && !hasText(value.content)) return false;
  if (value.source !== "personal") return true;
  if (value.name.length > PERSONAL_SKILL_LIMITS.name) return false;
  if (value.description.length > PERSONAL_SKILL_LIMITS.description) return false;
  if (!document) return true;
  if (value.revision === undefined) return false;
  const contentBytes = Buffer.byteLength(value.content as string, "utf8");
  return contentBytes <= PERSONAL_SKILL_LIMITS.contentBytes;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
