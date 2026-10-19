import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import { SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH, SUPERVISOR_TITLE_MAX_LENGTH } from "./contracts.js";

export type SupervisorPresentation = Readonly<{ acknowledgement?: string; title?: string }>;
export type SupervisorPresentationOptions = Readonly<{ includeAcknowledgement: boolean; includeTitle: boolean }>;

export function createSupervisorPresentationFormat(options: SupervisorPresentationOptions): ModelGatewayJsonSchemaFormat {
  const fields = presentationFields(options);
  return {
    type: "json_schema", name: "supervisor_presentation", strict: true,
    schema: createStructuredDecisionEnvelopeSchema([{
      type: "object",
      properties: Object.fromEntries(fields.map(([name, maxLength]) => [name, { type: "string", minLength: 2, maxLength }])),
      required: fields.map(([name]) => name), additionalProperties: false,
    }]),
    postValidatedSchemaConstraints: fields.map(([name]) => ({
      keyword: "maxLength", path: `/properties/decision/properties/${name}/maxLength`,
    })),
  };
}

export function buildSupervisorPresentationInstructions(options: SupervisorPresentationOptions): string {
  return [
    "Write only the requested opening acknowledgement and conversation title, in the user's language. Return exactly the supplied JSON shape.",
    "Do not plan, choose actions, answer the request, or claim completed work.",
    ...(options.includeAcknowledgement ? [`acknowledgement: at most ${SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH} characters; one short sentence acknowledging the requested outcome. No implementation details or promises about a particular method.`] : []),
    ...(options.includeTitle ? [`title: at most ${SUPERVISOR_TITLE_MAX_LENGTH} characters; a short description of the user's request.`] : []),
  ].join("\n");
}

export function parseSupervisorPresentationOutput(text: string, options: SupervisorPresentationOptions): StructuredModelParseResult<SupervisorPresentation> {
  let record: Record<string, unknown> | undefined;
  try { record = readStructuredDecisionEnvelope(JSON.parse(text)); } catch { /* Rejected below. */ }
  const fields = presentationFields(options);
  if (!record || Object.keys(record).length !== fields.length || fields.some(([name, max]) => !isBoundedPresentation(record![name], max))) {
    return { ok: false, stage: "domain_parser", issues: [{ code: "supervisor_presentation_invalid", path: "decision", message: "Return only the requested bounded acknowledgement/title fields." }] };
  }
  return { ok: true, decision: Object.freeze(Object.fromEntries(fields.map(([name]) => [name, (record[name] as string).trim()]))) };
}

function presentationFields(options: SupervisorPresentationOptions): readonly (readonly ["acknowledgement" | "title", number])[] {
  return [
    ...(options.includeAcknowledgement ? [["acknowledgement", SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH] as const] : []),
    ...(options.includeTitle ? [["title", SUPERVISOR_TITLE_MAX_LENGTH] as const] : []),
  ];
}

function isBoundedPresentation(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  return value.trim().length >= 2 && value.length <= maximum;
}
