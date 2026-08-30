import type {
  CapabilityControlsPartition,
  CapabilityControlsSchema,
} from "../../orchestration/capability-adapters/index.js";

import type { ExecutionAgentDecisionValidationIssue } from "./contracts.js";

export const EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH = 4_096;

const EXECUTION_AGENT_OPERATION_OBJECTIVE_DESCRIPTION =
  "Complete bounded operation for this invocation. This is internal execution input for controls refinement, not client-facing status, and cannot add unrelated request outcomes.";

type ParsedExecutionOperationObjective =
  | Readonly<{ ok: true; value?: string }>
  | Readonly<{ ok: false }>;

export function requiresExecutionOperationObjective(
  partition: CapabilityControlsPartition,
): boolean {
  return Object.keys(partition.remainingSchema.properties).length > 0;
}

export function executionOperationObjectiveSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH,
    description: EXECUTION_AGENT_OPERATION_OBJECTIVE_DESCRIPTION,
  };
}

export function parseExecutionOperationObjective(
  params: Readonly<{
    value: unknown;
    required: boolean;
    path: string;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): ParsedExecutionOperationObjective {
  if (!params.required) return Object.freeze({ ok: true as const });
  const normalized =
    typeof params.value === "string" ? params.value.trim() : "";
  if (
    typeof params.value !== "string" ||
    normalized.length === 0 ||
    params.value.length > EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH
  ) {
    params.issues.push({
      code: "execution_agent_operation_objective_invalid",
      path: params.path,
      message: `Operation objective must be text of 1-${EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH} characters.`,
    });
    return Object.freeze({ ok: false as const });
  }
  return Object.freeze({ ok: true as const, value: normalized });
}

export function normalizeGeneratedExecutionCapabilityControls(
  value: unknown,
  schema: CapabilityControlsSchema,
): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const required = new Set(schema.required);
  return Object.fromEntries(
    Object.entries(record).filter(
      ([controlId, controlValue]) =>
        controlValue !== null ||
        required.has(controlId) ||
        !Object.hasOwn(schema.properties, controlId),
    ),
  );
}

export function executionCapabilityControlsIssue(
  params: Readonly<{
    issueCode: string;
    controlId?: string;
    path: string;
  }>,
): ExecutionAgentDecisionValidationIssue {
  return {
    code: `execution_agent_capability_${params.issueCode}`,
    path: params.path,
    message: params.controlId
      ? `Capability control ${JSON.stringify(params.controlId)} failed ${params.issueCode}.`
      : `Capability controls failed ${params.issueCode}.`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
