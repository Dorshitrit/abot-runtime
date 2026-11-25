import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RuntimeFilesystemScope } from "../../context/runtime-filesystem-scope.js";
import { collectDecisionMaxLengthConstraints } from "../../model/decision-schema.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import type { SupervisorDecision } from "./contracts.js";
import { createSupervisorDecisionFormat } from "./format.js";
import { parseSupervisorDecisionOutput } from "./parser.js";
import { createSupervisorPresentationFormat, parseSupervisorPresentationOutput, type SupervisorPresentation, type SupervisorPresentationOptions } from "./presentation.js";
import { createSupervisorProcedureGateFormat, parseSupervisorProcedureGateOutput, type SupervisorProcedureGateDecision } from "./procedure-gate.js";
import { createSupervisorSkillSelectionFormat, parseSupervisorSkillSelectionOutput, type SupervisorSkillSelection } from "./skill-selection.js";
import { createSupervisorWorkingDirectoryFormat, mergeSupervisorWorkingDirectory, parseSupervisorWorkingDirectoryOutput } from "./working-directory.js";

export type FusedSupervisorEntry = Readonly<{
  presentation: SupervisorPresentation;
  selection: SupervisorSkillSelection;
  gate?: SupervisorProcedureGateDecision;
}>;

export function createFusedSupervisorEntryFormat(eligibleIds: readonly string[], presentation: SupervisorPresentationOptions): ModelGatewayJsonSchemaFormat {
  const reads = decisionVariants(createSupervisorSkillSelectionFormat(eligibleIds))
    .filter((variant) => (variant.properties as Record<string, { enum?: string[] }>).action?.enum?.includes("read_skills"));
  const fields = decisionVariants(createSupervisorPresentationFormat(presentation))[0]!;
  const variants = [...reads, ...decisionVariants(createSupervisorProcedureGateFormat())].map((variant) => ({
    ...variant,
    properties: { ...variant.properties as object, ...fields.properties as object },
    required: [...variant.required as string[], ...fields.required as string[]],
  }));
  return fusedFormat("supervisor_fused_entry", variants);
}

export function parseFusedSupervisorEntry(text: string, eligibleIds: readonly string[], options: SupervisorPresentationOptions): StructuredModelParseResult<FusedSupervisorEntry> {
  const record = decodeDecision(text);
  if (!record) return invalidFusedDecision("supervisor_fused_entry_invalid");
  const { presentation, decision } = splitPresentation(record, options);
  const parsedPresentation = parseSupervisorPresentationOutput(JSON.stringify({ decision: presentation }), options);
  if (!parsedPresentation.ok) return parsedPresentation;
  if (decision.action === "read_skills") {
    const selected = parseSupervisorSkillSelectionOutput(JSON.stringify({ decision }), eligibleIds);
    if (!selected.ok) return selected;
    return { ok: true, decision: { presentation: parsedPresentation.decision, selection: selected.decision } };
  }
  const gate = parseSupervisorProcedureGateOutput(JSON.stringify({ decision }));
  if (!gate.ok) return gate;
  return { ok: true, decision: { presentation: parsedPresentation.decision, selection: { action: "continue" }, gate: gate.decision } };
}

type FusedRoutingOptions = Parameters<typeof createSupervisorDecisionFormat>[0] & SupervisorPresentationOptions;

export function createFusedSupervisorRoutingFormat(options: FusedRoutingOptions): ModelGatewayJsonSchemaFormat {
  const directory = createSupervisorWorkingDirectoryFormat().schema.properties as Record<string, unknown>;
  const variants = decisionVariants(createSupervisorDecisionFormat({ ...options, includeResponseRecommendation: true })).map((variant) => {
    const properties = variant.properties as Record<string, { enum?: string[] }>;
    if (!properties.action?.enum?.includes("invoke_role")) return variant;
    return {
      ...variant,
      properties: { ...properties, workingDirectory: directory.workingDirectory },
      required: [...variant.required as string[], "workingDirectory"],
    };
  });
  return fusedFormat("supervisor_fused_routing", variants);
}

export function parseFusedSupervisorRouting(text: string, options: FusedRoutingOptions, filesystemScope?: RuntimeFilesystemScope): StructuredModelParseResult<SupervisorDecision> {
  const record = decodeDecision(text);
  if (!record) return invalidFusedDecision("supervisor_fused_routing_invalid");
  const invokesRole = record.action === "invoke_role";
  const { workingDirectory, ...routing } = record;
  if (!invokesRole && Object.hasOwn(record, "workingDirectory")) return invalidFusedDecision("supervisor_fused_directory_unexpected");
  const accepted = parseSupervisorDecisionOutput(JSON.stringify({ decision: invokesRole ? routing : record }), { ...options, includeResponseRecommendation: true });
  if (!accepted.ok) return accepted;
  if (accepted.decision.action === "respond" || accepted.decision.action === "recall_memory") return { ok: true, decision: accepted.decision };
  if (accepted.decision.action !== "invoke_role") return invalidFusedDecision("supervisor_fused_action_invalid");
  if (accepted.decision.roleId !== "worker" && accepted.decision.roleId !== "planner") return invalidFusedDecision("supervisor_fused_role_invalid");
  const directory = parseSupervisorWorkingDirectoryOutput(JSON.stringify({ workingDirectory }), { filesystemScope });
  if (!directory.ok) return directory;
  return { ok: true, decision: mergeSupervisorWorkingDirectory(accepted.decision, directory.decision) };
}

function decisionVariants(format: ModelGatewayJsonSchemaFormat): Record<string, unknown>[] {
  const decision = (format.schema.properties as Record<string, unknown>).decision as Record<string, unknown>;
  return (decision.anyOf as Record<string, unknown>[] | undefined) ?? [decision];
}

function fusedFormat(name: string, variants: Record<string, unknown>[]): ModelGatewayJsonSchemaFormat {
  const schema = createStructuredDecisionEnvelopeSchema(variants);
  return { type: "json_schema", name, strict: true, schema, postValidatedSchemaConstraints: collectDecisionMaxLengthConstraints(schema) };
}

function decodeDecision(text: string) {
  try { return readStructuredDecisionEnvelope(JSON.parse(text)); } catch { return undefined; }
}

function splitPresentation(record: Record<string, unknown>, options: SupervisorPresentationOptions) {
  const decision = { ...record };
  const presentation: Record<string, unknown> = {};
  for (const [field, included] of [["acknowledgement", options.includeAcknowledgement], ["title", options.includeTitle]] as const) {
    if (!included) continue;
    presentation[field] = decision[field];
    delete decision[field];
  }
  return { presentation, decision };
}

function invalidFusedDecision(code: string): StructuredModelParseResult<never> {
  return { ok: false, stage: "domain_parser", issues: [{ code, path: "decision", message: "Return exactly one offered decision with its required fields." }] };
}
