import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { ExecutionAgentDecisionContractOptions, ExecutionAgentDecisionParseResult } from "./contracts.js";
import { parseExecutionAgentDecisionOutput } from "./decision-parsing.js";

/** Null transport slots mean absence only where the live contract permits absence. */
export function parseStableExecutionAgentDecisionOutput(
  text: string,
  contract: ExecutionAgentDecisionContractOptions,
  format: ModelGatewayJsonSchemaFormat,
): ExecutionAgentDecisionParseResult {
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return parseExecutionAgentDecisionOutput(text, contract); }
  const source = readStructuredDecisionEnvelope(decoded);
  if (!source) return parseExecutionAgentDecisionOutput(text, contract);
  const decision = { ...source };
  const declaredSlots = declaredNullSlots(format, decision.action);
  const omit = (field: string, permitsAbsence: boolean) =>
    omitNullSlot(decision, field, permitsAbsence && declaredSlots.has(field));
  omit("workPlan", true);
  omit("interaction", true);
  const selectsCapability = decision.action === "invoke_capability" || decision.action === "invoke_capabilities";
  omit("workingDirectory", selectsCapability && contract.includeWorkingDirectory !== true);
  return parseExecutionAgentDecisionOutput(JSON.stringify({ decision }), contract);
}

function declaredNullSlots(format: ModelGatewayJsonSchemaFormat, action: unknown): ReadonlySet<string> {
  const properties = asRecord(format.schema.properties);
  const decision = asRecord(properties?.decision);
  const variants = Array.isArray(decision?.anyOf) ? decision.anyOf : [decision];
  const slots = new Set<string>();
  for (const variant of variants) {
    const fields = asRecord(asRecord(variant)?.properties);
    if (!fields) continue;
    const actions = asRecord(fields.action)?.enum;
    if (!Array.isArray(actions) || !actions.includes(action)) continue;
    for (const [field, schema] of Object.entries(fields)) {
      const alternatives = asRecord(schema)?.anyOf;
      if (Array.isArray(alternatives) && alternatives.some((alternative) => asRecord(alternative)?.type === "null"))
        slots.add(field);
    }
  }
  return slots;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function omitNullSlot(decision: Record<string, unknown>, field: string, permitsAbsence: boolean): void {
  if (!permitsAbsence) return;
  if (decision[field] === null) delete decision[field];
}
