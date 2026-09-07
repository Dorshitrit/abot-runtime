import {
  CAPABILITY_INTENT_MAX_LENGTH,
  materializeCapabilityControlsIfComplete,
  validateCapabilitySelectionControls,
  type CapabilityControls,
} from "../../orchestration/capability-adapters/index.js";
import { normalizeExecutionWorkingDirectory } from "../../orchestration/capability-adapters/working-directory.js";
import {
  executionCapabilityControlsIssue,
  normalizeGeneratedExecutionCapabilityControls,
  parseExecutionOperationObjective,
  requiresExecutionOperationObjective,
} from "./capability-invocation-contract.js";
import {
  EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
  type ExecutionAgentCapabilityInvocation,
  type ExecutionAgentDecisionValidationIssue,
} from "./contracts.js";
import type {
  PreparedExecutionAgentCapability,
  PreparedExecutionAgentDecisionContract,
} from "./format.js";
import {
  asRecord,
  exactKeys,
  issue,
  validateBoundedText,
} from "./decision-validation.js";

export function parseCapabilityCatalogGroupIds(
  value: unknown,
  offeredCatalogGroupIds: readonly string[],
  issues: ExecutionAgentDecisionValidationIssue[],
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX ||
    new Set(value).size !== value.length ||
    value.some((entry) => typeof entry !== "string")
  ) {
    issues.push(
      issue(
        "execution_agent_capability_scope_invalid",
        "decision.catalogGroupIds",
        `catalogGroupIds must contain 1-${EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX} distinct offered group ids.`,
      ),
    );
    return undefined;
  }
  const catalogGroupIds = value as string[];
  if (
    catalogGroupIds.some((groupId) => !offeredCatalogGroupIds.includes(groupId))
  ) {
    issues.push(
      issue(
        "execution_agent_capability_scope_group_unavailable",
        "decision.catalogGroupIds",
        "Every catalogGroupId must identify one group offered for this exact scope action.",
      ),
    );
    return undefined;
  }
  return Object.freeze([...catalogGroupIds]);
}

export function parseCapabilityBatch(
  value: unknown,
  contract: PreparedExecutionAgentDecisionContract,
  issues: ExecutionAgentDecisionValidationIssue[],
): readonly ExecutionAgentCapabilityInvocation[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    contract.maxBatchCapabilityExecutions < 2 ||
    value.length > contract.maxBatchCapabilityExecutions
  ) {
    issues.push(
      issue(
        "execution_agent_capability_batch_invalid",
        "decision.invocations",
        `Observation batch must contain 2-${contract.maxBatchCapabilityExecutions} invocations.`,
      ),
    );
    return undefined;
  }
  const accepted: ExecutionAgentCapabilityInvocation[] = [];
  const issueCountBeforeInvocations = issues.length;
  value.forEach((invocation, index) => {
    const parsed = parseCapabilityInvocation({
      value: invocation,
      path: `decision.invocations.${index}`,
      capabilities: contract.capabilities,
      observationOnly: true,
      includesAction: false,
      issues,
    });
    if (parsed.value) accepted.push(parsed.value);
  });
  const invocationValidationFailed =
    accepted.length !== value.length ||
    issues.length !== issueCountBeforeInvocations;
  if (invocationValidationFailed) return undefined;

  return Object.freeze(accepted);
}

export function parseCapabilityInvocation(
  params: Readonly<{
    value: unknown;
    path: string;
    capabilities: readonly PreparedExecutionAgentCapability[];
    observationOnly: boolean;
    includesAction: boolean;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): Readonly<{
  value?: ExecutionAgentCapabilityInvocation;
  expectedKeys: readonly string[];
}> {
  const record = asRecord(params.value);
  const baseExpectedKeys = [
    ...(params.includesAction ? ["action"] : []),
    "capabilityId",
    "intent",
  ];
  if (!record) {
    params.issues.push(
      issue(
        "execution_agent_capability_invocation_invalid",
        params.path,
        "Capability invocation must be an object.",
      ),
    );
    return { expectedKeys: baseExpectedKeys };
  }
  let capability: PreparedExecutionAgentCapability | undefined;
  if (typeof record.capabilityId !== "string") {
    params.issues.push(
      issue(
        "execution_agent_capability_id_invalid",
        `${params.path}.capabilityId`,
        "capabilityId must identify one available capability.",
      ),
    );
  } else {
    capability = params.capabilities.find(
      ({ capabilityId }) => capabilityId === record.capabilityId,
    );
    if (!capability) {
      params.issues.push(
        issue(
          "execution_agent_capability_unavailable",
          `${params.path}.capabilityId`,
          "capabilityId must identify one available capability.",
        ),
      );
    } else if (params.observationOnly && capability.effect !== "observation") {
      params.issues.push(
        issue(
          "execution_agent_capability_batch_effect_invalid",
          `${params.path}.capabilityId`,
          "Only observation capabilities may be invoked in a batch.",
        ),
      );
    }
  }
  const expectedKeys = [
    ...baseExpectedKeys,
    ...(capability && requiresExecutionOperationObjective(capability.partition)
      ? ["operationObjective"]
      : []),
    ...(capability?.partition.selectionControlIds.length
      ? ["selectionControls"]
      : []),
  ];
  if (!params.includesAction) {
    exactKeys(record, expectedKeys, params.issues, params.path);
  }
  const intent = validateBoundedText({
    value: record.intent,
    maximumLength: CAPABILITY_INTENT_MAX_LENGTH,
    code: "execution_agent_capability_intent_invalid",
    path: `${params.path}.intent`,
    label: "Capability intent",
    issues: params.issues,
  });
  const operationObjective = parseExecutionOperationObjective({
    value: record.operationObjective,
    required:
      capability !== undefined &&
      requiresExecutionOperationObjective(capability.partition),
    path: `${params.path}.operationObjective`,
    issues: params.issues,
  });
  let selectionControls: CapabilityControls | undefined;
  let controls: CapabilityControls | undefined;
  if (capability) {
    const normalizedSelectionControls =
      capability.partition.selectionControlIds.length > 0
        ? normalizeGeneratedExecutionCapabilityControls(
            record.selectionControls,
            capability.partition.selectionSchema,
          )
        : {};
    const selection = validateCapabilitySelectionControls(
      capability.partition,
      normalizedSelectionControls,
    );
    if (!selection.ok) {
      params.issues.push(
        executionCapabilityControlsIssue({
          issueCode: selection.issueCode,
          controlId: selection.controlId,
          path: selection.controlId
            ? `${params.path}.selectionControls.${selection.controlId}`
            : `${params.path}.selectionControls`,
        }),
      );
    } else {
      if (capability.partition.selectionControlIds.length > 0) {
        selectionControls = selection.value;
      }
      const materialized = materializeCapabilityControlsIfComplete(
        capability.partition,
        selection.value,
      );
      if (materialized && !materialized.ok) {
        params.issues.push(
          executionCapabilityControlsIssue({
            issueCode: materialized.issueCode,
            controlId: materialized.controlId,
            path: materialized.controlId
              ? `${params.path}.selectionControls.${materialized.controlId}`
              : `${params.path}.selectionControls`,
          }),
        );
      } else if (materialized?.ok) {
        controls = materialized.value;
      }
    }
  }
  if (
    !capability ||
    (params.observationOnly && capability.effect !== "observation") ||
    intent === undefined ||
    !operationObjective.ok
  ) {
    return { expectedKeys };
  }
  return {
    expectedKeys,
    value: Object.freeze({
      capabilityId: capability.capabilityId,
      intent,
      ...(operationObjective.value
        ? { operationObjective: operationObjective.value }
        : {}),
      ...(selectionControls ? { selectionControls } : {}),
      ...(controls ? { controls } : {}),
    }),
  };
}

export function parseWorkingDirectory(
  record: Record<string, unknown>,
  contract: PreparedExecutionAgentDecisionContract,
  issues: ExecutionAgentDecisionValidationIssue[],
): string | undefined {
  if (!contract.includeWorkingDirectory) return undefined;
  if (record.workingDirectory === null) return ".";
  const normalized = normalizeExecutionWorkingDirectory(
    record.workingDirectory,
  );
  if (!normalized) {
    issues.push(
      issue(
        "execution_agent_working_directory_invalid",
        "decision.workingDirectory",
        "workingDirectory must be one safe agent-root-relative directory.",
      ),
    );
  }
  return normalized;
}
