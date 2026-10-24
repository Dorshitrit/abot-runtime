import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  createStructuredDecisionEnvelopeSchema,
  readStructuredDecisionEnvelope,
  structuredDecisionVariantSchemaPath,
} from "../../model/structured-decision-envelope.js";
import {
  SUPERVISOR_DELEGATE_ROLE_IDS,
  type SupervisorDelegateRoleId,
  type SupervisorRoutingDecisionParseResult,
} from "./contracts.js";
import { traceSupervisorDecisionRejected, traceSupervisorEnvelopeAccepted } from "./diagnostics.js";
import { createSupervisorDecisionFormat } from "./format.js";
import { parseSupervisorDecisionOutput } from "./parser.js";

type CanonicalParserOptions = NonNullable<Parameters<typeof parseSupervisorDecisionOutput>[1]>;
export type SupervisorDelegationOptions = Pick<CanonicalParserOptions, "allowedRoleIds" | "allowMemoryRecall">;

/** Initial delegation offers Worker/Planner and eligible root recall, never tools or response. */
export function createSupervisorDelegationFormat(
  options: SupervisorDelegationOptions = {},
): ModelGatewayJsonSchemaFormat {
  const canonical = createSupervisorDecisionFormat(canonicalDelegationOptions(options));
  const decision = (canonical.schema.properties as Record<string, unknown>).decision as Record<string, unknown>;
  const canonicalVariants = (decision.anyOf as Record<string, unknown>[] | undefined) ?? [decision];
  const variants = canonicalVariants.slice(1);
  if (!hasDelegationActions(variants)) throw new Error("supervisor_delegation_actions_unavailable");
  return {
    ...canonical,
    name: "supervisor_delegation",
    schema: createStructuredDecisionEnvelopeSchema(variants),
    postValidatedSchemaConstraints: rebaseDelegationConstraints(canonical, canonicalVariants.length),
  };
}

export function parseSupervisorDelegationOutput(
  text: string,
  options: CanonicalParserOptions = {},
): SupervisorRoutingDecisionParseResult {
  const response = readForbiddenDelegationResponse(text);
  if (response) {
    const issues = [{
      code: "supervisor_delegation_action_invalid", path: "decision.action",
      message: "Choose an offered delegation action; respond belongs to the preceding gate.",
    }];
    if (options.diagnostic) {
      traceSupervisorEnvelopeAccepted({
        diagnostic: options.diagnostic, outputLength: text.length, keyCount: Object.keys(response).length,
      });
      traceSupervisorDecisionRejected({ diagnostic: options.diagnostic, selectedAction: "respond", issues });
    }
    return { ok: false, stage: "domain_parser", issues };
  }
  return parseSupervisorDecisionOutput(text, {
    ...canonicalDelegationOptions(options),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
  });
}

function canonicalDelegationOptions(options: SupervisorDelegationOptions) {
  const allowedRoleIds = (options.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS).filter(isDelegationRole);
  const canRecallBeforeDelegation = options.allowMemoryRecall === true && allowedRoleIds.length > 0;
  return {
    allowMemoryRecall: canRecallBeforeDelegation,
    allowSkillAuthoring: false,
    allowedRoleIds,
    availableWorkerCapabilityCatalog: [],
    includeAcknowledgement: false,
    includeTitle: false,
    includeResponseRecommendation: false,
  };
}

function isDelegationRole(roleId: SupervisorDelegateRoleId): boolean {
  return roleId === "worker" || roleId === "planner";
}

function hasDelegationActions(variants: readonly Record<string, unknown>[]): boolean {
  return variants.length > 0;
}

function readForbiddenDelegationResponse(text: string): Record<string, unknown> | undefined {
  try {
    const record = readStructuredDecisionEnvelope(JSON.parse(text));
    return record?.action === "respond" ? record : undefined;
  } catch {
    return undefined;
  }
}

function rebaseDelegationConstraints(
  canonical: ModelGatewayJsonSchemaFormat,
  canonicalVariantCount: number,
): NonNullable<ModelGatewayJsonSchemaFormat["postValidatedSchemaConstraints"]> {
  return (canonical.postValidatedSchemaConstraints ?? []).map((constraint) => {
    const originalIndex = Array.from({ length: canonicalVariantCount }, (_, index) => index)
      .find((index) => constraint.path.startsWith(`${structuredDecisionVariantSchemaPath(index, canonicalVariantCount)}/`));
    if (!isDelegationConstraintIndex(originalIndex)) throw new Error("supervisor_delegation_constraint_invalid");
    const originalPrefix = structuredDecisionVariantSchemaPath(originalIndex, canonicalVariantCount);
    const delegationPrefix = structuredDecisionVariantSchemaPath(originalIndex - 1, canonicalVariantCount - 1);
    return { ...constraint, path: delegationPrefix + constraint.path.slice(originalPrefix.length) };
  });
}

function isDelegationConstraintIndex(index: number | undefined): index is number {
  return index !== undefined && index > 0;
}
