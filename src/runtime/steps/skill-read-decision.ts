import {
  isKnowledgeSkillReadReference,
  KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH,
} from "../capabilities/knowledge-skills/read-targets.js";
import { KNOWLEDGE_SKILL_READ_MAX_ITEMS } from "../knowledge-skills/store.js";

type SkillReadPresentation = Readonly<{
  acknowledgement?: string;
  title?: string;
}>;

export type SkillReadDecision = SkillReadPresentation & (
  | Readonly<{ action: "list_skills" }>
  | Readonly<{ action: "read_skills"; skillIds: readonly string[] }>
);

type SkillReadPresentationContract = Readonly<{
  includeAcknowledgement?: boolean;
  includeTitle?: boolean;
  acknowledgementMaxLength: number;
  titleMaxLength: number;
}>;

type SkillReadValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export function createSkillReadDecisionSchemas(
  options: SkillReadPresentationContract,
): readonly Record<string, unknown>[] {
  const presentation = {
    ...(options.includeAcknowledgement
      ? { acknowledgement: { type: "string", minLength: 2, maxLength: options.acknowledgementMaxLength } }
      : {}),
    ...(options.includeTitle
      ? { title: { type: "string", minLength: 2, maxLength: options.titleMaxLength } }
      : {}),
  };
  return ["list_skills", "read_skills"].map((action) => {
    const properties = {
      action: { type: "string", enum: [action] },
      ...(action === "read_skills"
        ? { skillIds: {
            type: "array", minItems: 1, maxItems: KNOWLEDGE_SKILL_READ_MAX_ITEMS,
            items: { type: "string", minLength: 1, maxLength: KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH },
          } }
        : {}),
      ...presentation,
    };
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  });
}

export function isSkillReadDecisionRecord(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return record.action === "list_skills" || record.action === "read_skills";
}

export function parseSkillReadDecision(
  record: Readonly<Record<string, unknown>>,
  options: SkillReadPresentationContract & Readonly<{ allowSkillReads?: boolean }>,
):
  | Readonly<{ ok: true; decision: SkillReadDecision }>
  | Readonly<{ ok: false; stage: "domain_parser"; issues: readonly SkillReadValidationIssue[] }> {
  if (!options.allowSkillReads)
    return rejectSkillRead("skill_read_unavailable", "action", "Core Skill reads are not available for this decision.");
  if (!isSkillReadDecisionRecord(record))
    return rejectSkillRead("skill_read_action_invalid", "action", "Expected list_skills or read_skills.");
  const expectedKeys = [
    "action",
    ...(record.action === "read_skills" ? ["skillIds"] : []),
    ...(options.includeAcknowledgement ? ["acknowledgement"] : []),
    ...(options.includeTitle ? ["title"] : []),
  ];
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key) => !expectedKeys.includes(key)))
    return rejectSkillRead("skill_read_shape_invalid", "", "Fields must match the offered Skill action.");
  if (record.action === "read_skills" && !hasValidSkillReadReferences(record.skillIds))
    return rejectSkillRead("skill_read_references_invalid", "skillIds", "Supply one to eight distinct exact Skill IDs or full names.");
  for (const [field, maximum] of [
    ["acknowledgement", options.acknowledgementMaxLength],
    ["title", options.titleMaxLength],
  ] as const) {
    if (!expectedKeys.includes(field)) continue;
    if (!hasBoundedSkillPresentation(record[field], maximum))
      return rejectSkillRead("skill_read_presentation_invalid", field, "Presentation text exceeds the offered bounds.");
  }
  const presentation = {
    ...(options.includeAcknowledgement ? { acknowledgement: (record.acknowledgement as string).trim() } : {}),
    ...(options.includeTitle ? { title: (record.title as string).trim() } : {}),
  };
  if (record.action === "list_skills")
    return { ok: true, decision: Object.freeze({ action: "list_skills", ...presentation }) };
  return {
    ok: true,
    decision: Object.freeze({
      action: "read_skills",
      skillIds: Object.freeze([...(record.skillIds as string[])]),
      ...presentation,
    }),
  };
}

function hasValidSkillReadReferences(value: unknown): value is readonly string[] {
  return classifySkillReadReferences(value) === "valid";
}

export function classifySkillReadReferences(value: unknown): "valid" | "invalid" | "duplicate" {
  if (!Array.isArray(value)) return "invalid";
  if (value.length === 0 || value.length > KNOWLEDGE_SKILL_READ_MAX_ITEMS) return "invalid";
  if (!value.every(isKnowledgeSkillReadReference)) return "invalid";
  if (new Set(value).size !== value.length) return "duplicate";
  return "valid";
}

function hasBoundedSkillPresentation(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length > maximum) return false;
  return value.trim().length >= 2;
}

function rejectSkillRead(code: string, field: string, message: string) {
  return {
    ok: false as const,
    stage: "domain_parser" as const,
    issues: Object.freeze([{ code, path: field ? `decision.${field}` : "decision", message }]),
  };
}
