import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { validateToolNormalInvocationInput } from "../../../capabilities/normal-invocation/index.js";
import { knowledgeSkillWriteOperations } from "../../capabilities/knowledge-skills/write-contract.js";
import type { KnowledgeSkillMetadata } from "../../knowledge-skills/store.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope, structuredDecisionVariantSchemaPath } from "../../model/structured-decision-envelope.js";

export type SupervisorSkillAuthoringSelection =
  | Readonly<{ action: "create_skill"; name: string; description: string }>
  | Readonly<{ action: "update_skill"; skillId: string; name?: string; description?: string }>
  | Readonly<{ action: "no_save"; reason: string }>;
export type SupervisorSkillWriteSelection = Exclude<SupervisorSkillAuthoringSelection, { action: "no_save" }>;
export type SupervisorSkillAuthoringOptions = Readonly<{
  writeOperationIds: readonly string[];
  personalSkills: readonly KnowledgeSkillMetadata[];
}>;
export const SUPERVISOR_SKILL_NO_SAVE_REASON_MAX_LENGTH = 300;
export const SUPERVISOR_SKILL_AUTHORING_ROUTE_SCHEMA = {
  type: "object", properties: { action: { type: "string", enum: ["author_skill"] } },
  required: ["action"], additionalProperties: false,
};

export function isSupervisorSkillWriteSelection(
  decision: Readonly<{ action: string }>,
): decision is SupervisorSkillWriteSelection {
  return decision.action === "create_skill" || decision.action === "update_skill";
}

export function parseSupervisorSkillAuthoringRoute(
  record: Readonly<Record<string, unknown>>, allowed: boolean,
): StructuredModelParseResult<Readonly<{ action: "author_skill" }>> {
  if (!allowed || record.action !== "author_skill" || Object.keys(record).length !== 1)
    return invalid("Use only the offered author_skill action; selection fields belong to its separate step.");
  return { ok: true, decision: { action: "author_skill" } };
}

export function createSupervisorSkillAuthoringFormat(
  options: SupervisorSkillAuthoringOptions,
): ModelGatewayJsonSchemaFormat {
  const operations = offeredOperations(options);
  const variants = [
    ...operations.map((operation) => ({
      ...operation.input,
      properties: { action: { type: "string", enum: [operation.operationId] }, ...operation.input.properties },
      required: ["action", ...operation.input.required],
    })),
    { type: "object", additionalProperties: false,
      properties: { action: { type: "string", enum: ["no_save"] }, reason: {
        type: "string", minLength: 1, maxLength: SUPERVISOR_SKILL_NO_SAVE_REASON_MAX_LENGTH,
      } }, required: ["action", "reason"] },
  ];
  return {
    type: "json_schema", name: "supervisor_skill_authoring", strict: true,
    schema: createStructuredDecisionEnvelopeSchema(variants),
    postValidatedSchemaConstraints: variants.flatMap((variant, index) =>
      Object.entries(variant.properties).flatMap(([name, property]) =>
        "maxLength" in property ? [{ keyword: "maxLength" as const,
          path: `${structuredDecisionVariantSchemaPath(index, variants.length)}/properties/${name}/maxLength` }] : [])),
  };
}

export function parseSupervisorSkillAuthoringOutput(
  text: string, options: SupervisorSkillAuthoringOptions,
): StructuredModelParseResult<SupervisorSkillAuthoringSelection> {
  let record: Record<string, unknown> | undefined;
  try { record = readStructuredDecisionEnvelope(JSON.parse(text)); }
  catch { return invalid("Return one JSON decision object in the supplied envelope."); }
  if (!record) return invalid("Return one JSON decision object in the supplied envelope.");
  if (record.action === "no_save") {
    if (Object.keys(record).length !== 2 || typeof record.reason !== "string" ||
      !record.reason.trim() || record.reason.length > SUPERVISOR_SKILL_NO_SAVE_REASON_MAX_LENGTH)
      return invalid("no_save requires only a concise reason within the supplied limit.");
    return { ok: true, decision: { action: "no_save", reason: record.reason.trim() } };
  }
  const operation = offeredOperations(options).find(({ operationId }) => operationId === record.action);
  if (!operation) return invalid("Choose an offered create_skill, update_skill or no_save action.");
  const { action: _action, ...controls } = record;
  const validated = validateToolNormalInvocationInput(operation, controls);
  if (!validated.ok) return invalid("Return only valid metadata controls from the supplied schema.");
  if (operation.operationId === "create_skill") return { ok: true, decision: {
    action: "create_skill", name: validated.value.name as string, description: validated.value.description as string,
  } };
  return { ok: true, decision: {
    action: "update_skill", skillId: validated.value.skillId as string,
    ...(validated.value.name !== undefined ? { name: validated.value.name as string } : {}),
    ...(validated.value.description !== undefined ? { description: validated.value.description as string } : {}),
  } };
}

function offeredOperations(options: SupervisorSkillAuthoringOptions) {
  return knowledgeSkillWriteOperations.filter(({ operationId }) =>
    options.writeOperationIds.includes(operationId) &&
    (operationId !== "update_skill" || options.personalSkills.length > 0),
  ).map((operation) => {
    if (operation.operationId !== "update_skill") return operation;
    const { expectedRevision: _revision, ...properties } = operation.input.properties;
    return { ...operation, input: { ...operation.input, required: ["skillId"], properties: {
      ...properties, skillId: { ...properties.skillId, enum: options.personalSkills.map(({ skillId }) => skillId) },
    } } };
  });
}

function invalid(message: string): StructuredModelParseResult<never> {
  return { ok: false, stage: "domain_parser", issues: [
    { code: "supervisor_skill_authoring_invalid", path: "decision", message },
  ] };
}
