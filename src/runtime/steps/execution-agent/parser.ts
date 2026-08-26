import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import {
  CAPABILITY_INTENT_MAX_LENGTH,
  materializeCapabilityControlsIfComplete,
  validateCapabilitySelectionControls,
  type CapabilityControls,
  type CapabilityControlsSchema,
} from "../../orchestration/capability-adapters/index.js";
import { normalizeExecutionWorkingDirectory } from "../../orchestration/capability-adapters/working-directory.js";
import {
  EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
  EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
  EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
  EXECUTION_AGENT_DECISION_ACTIONS,
  EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH,
  EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
  EXECUTION_AGENT_TITLE_MAX_LENGTH,
  type ExecutionAgentCapabilityInvocation,
  type ExecutionAgentDecision,
  type ExecutionAgentDecisionAction,
  type ExecutionAgentDecisionContractOptions,
  type ExecutionAgentDecisionParseResult,
  type ExecutionAgentDecisionPresentation,
  type ExecutionAgentDecisionValidationIssue,
  type ExecutionAgentExtendCapabilityScopeDecision,
  type ExecutionAgentOpenCapabilityScopeDecision,
} from "./contracts.js";
import {
  prepareExecutionAgentDecisionContract,
  type PreparedExecutionAgentCapability,
  type PreparedExecutionAgentDecisionContract,
} from "./format.js";

export function parseExecutionAgentDecisionOutput(
  text: string,
  options: ExecutionAgentDecisionContractOptions = {},
): ExecutionAgentDecisionParseResult {
  const contract = prepareExecutionAgentDecisionContract(options);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectEnvelope([
      issue(
        "execution_agent_output_not_json",
        "decision",
        "Expected one JSON object.",
      ),
    ]);
  }
  if (!asRecord(decoded)) {
    return rejectEnvelope([
      issue(
        "execution_agent_output_not_object",
        "decision",
        "Expected one JSON object.",
      ),
    ]);
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record) {
    return rejectEnvelope([
      issue(
        "execution_agent_output_envelope_invalid",
        "decision",
        "Expected exactly one decision object inside the canonical envelope.",
      ),
    ]);
  }

  const issues: ExecutionAgentDecisionValidationIssue[] = [];
  const selectedAction = readAction(record.action);
  if (!selectedAction) {
    issues.push(
      issue(
        "execution_agent_action_invalid",
        "decision.action",
        `Action must be one of: ${EXECUTION_AGENT_DECISION_ACTIONS.join(", ")}.`,
      ),
    );
  }
  const presentation = parsePresentation(record, contract, issues);
  let decision: ExecutionAgentDecision | undefined;

  if (selectedAction === "open_capability_scope") {
    exactKeys(
      record,
      ["action", "catalogGroupIds", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    const catalogGroupIds = parseCapabilityCatalogGroupIds(
      record.catalogGroupIds,
      contract.capabilityCatalogGroupIds,
      issues,
    );
    if (
      contract.activeCapabilityCatalogGroupIds !== null ||
      contract.capabilityCatalogGroupIds.length === 0
    ) {
      issues.push(
        issue(
          "execution_agent_capability_scope_open_unavailable",
          "decision.action",
          "open_capability_scope is available only while the canonical capability scope is closed.",
        ),
      );
    }
    if (catalogGroupIds) {
      decision = {
        action: "open_capability_scope",
        catalogGroupIds,
        ...presentation,
      } satisfies ExecutionAgentOpenCapabilityScopeDecision;
    }
  } else if (selectedAction === "respond") {
    exactKeys(
      record,
      ["action", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    if (!contract.allowRespond) {
      issues.push(
        issue(
          "execution_agent_response_not_allowed",
          "decision.action",
          "respond is not available until the canonical completion gate is open.",
        ),
      );
    }
    decision = {
      action: "respond",
      ...presentation,
    };
  } else if (selectedAction === "blocked") {
    exactKeys(
      record,
      ["action", "response", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    const response = validateBoundedText({
      value: record.response,
      maximumLength: EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
      code: "execution_agent_response_invalid",
      path: "decision.response",
      label: "Response",
      issues,
    });
    if (response !== undefined) {
      decision = {
        action: "blocked",
        response,
        ...presentation,
      };
    }
  } else if (selectedAction === "invoke_capability") {
    const invocation = parseCapabilityInvocation({
      value: record,
      path: "decision",
      capabilities: contract.capabilities,
      observationOnly: false,
      includesAction: true,
      issues,
    });
    exactPresentationKeys(
      record,
      contract,
      [
        ...invocation.expectedKeys,
        ...(contract.includeWorkingDirectory ? ["workingDirectory"] : []),
      ],
      issues,
    );
    const workingDirectory = parseWorkingDirectory(record, contract, issues);
    if (invocation.value) {
      decision = {
        action: "invoke_capability",
        ...invocation.value,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...presentation,
      };
    }
  } else if (selectedAction === "invoke_capabilities") {
    exactKeys(
      record,
      [
        "action",
        "invocations",
        ...(contract.includeWorkingDirectory ? ["workingDirectory"] : []),
        ...presentationKeys(contract),
      ],
      issues,
      "decision",
    );
    const invocations = parseCapabilityBatch(
      record.invocations,
      contract,
      issues,
    );
    const workingDirectory = parseWorkingDirectory(record, contract, issues);
    if (invocations) {
      decision = {
        action: "invoke_capabilities",
        invocations,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...presentation,
      };
    }
  } else if (selectedAction === "extend_capability_scope") {
    exactKeys(
      record,
      ["action", "catalogGroupIds", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    const catalogGroupIds = parseCapabilityCatalogGroupIds(
      record.catalogGroupIds,
      contract.inactiveCapabilityCatalogGroupIds,
      issues,
    );
    if (
      contract.activeCapabilityCatalogGroupIds === null ||
      contract.inactiveCapabilityCatalogGroupIds.length === 0
    ) {
      issues.push(
        issue(
          "execution_agent_capability_scope_extend_unavailable",
          "decision.action",
          "extend_capability_scope is available only while a canonical capability scope is active and at least one inactive group is offered.",
        ),
      );
    }
    if (catalogGroupIds) {
      decision = {
        action: "extend_capability_scope",
        catalogGroupIds,
        ...presentation,
      } satisfies ExecutionAgentExtendCapabilityScopeDecision;
    }
  } else if (selectedAction === "invoke_planner") {
    exactKeys(
      record,
      ["action", "objective", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    if (!contract.allowPlanner) {
      issues.push(
        issue(
          "execution_agent_planner_not_allowed",
          "decision.action",
          "Planner invocation is not available for this decision.",
        ),
      );
    }
    const objective = validateObjective(record.objective, issues);
    if (objective !== undefined) {
      decision = {
        action: "invoke_planner",
        objective,
        ...presentation,
      };
    }
  } else if (selectedAction === "invoke_auditor") {
    exactKeys(
      record,
      ["action", "criterionIds", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    if (
      !contract.allowAuditor ||
      contract.availableAuditCriterionIds.length === 0
    ) {
      issues.push(
        issue(
          "execution_agent_auditor_not_allowed",
          "decision.action",
          "Auditor invocation is not available for this decision.",
        ),
      );
    }
    const criterionIds = parseBoundedTextArray({
      value: record.criterionIds,
      path: "decision.criterionIds",
      code: "execution_agent_audit_criteria_invalid",
      label: "Audit criterion ids",
      itemMaximumLength: EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
      maximumItems: EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
      issues,
    });
    if (
      criterionIds?.some(
        (criterionId) =>
          !contract.availableAuditCriterionIds.includes(criterionId),
      )
    ) {
      issues.push(
        issue(
          "execution_agent_audit_criteria_unavailable",
          "decision.criterionIds",
          "criterionIds must identify unresolved semantic criteria offered by the runtime.",
        ),
      );
    }
    if (criterionIds) {
      decision = {
        action: "invoke_auditor",
        criterionIds,
        ...presentation,
      };
    }
  }

  if (issues.length > 0 || !decision) {
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }
  return {
    ok: true,
    decision: deepFreeze(structuredClone(decision)),
  };
}

function parseCapabilityCatalogGroupIds(
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

function parseCapabilityBatch(
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
  return accepted.length === value.length ? Object.freeze(accepted) : undefined;
}

function parseCapabilityInvocation(
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
  let selectionControls: CapabilityControls | undefined;
  let controls: CapabilityControls | undefined;
  if (capability) {
    const normalizedSelectionControls =
      capability.partition.selectionControlIds.length > 0
        ? normalizeGeneratedCapabilityControls(
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
        capabilityControlsIssue({
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
          capabilityControlsIssue({
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
    intent === undefined
  ) {
    return { expectedKeys };
  }
  return {
    expectedKeys,
    value: Object.freeze({
      capabilityId: capability.capabilityId,
      intent,
      ...(selectionControls ? { selectionControls } : {}),
      ...(controls ? { controls } : {}),
    }),
  };
}

function parseWorkingDirectory(
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

function parsePresentation(
  record: Record<string, unknown>,
  contract: PreparedExecutionAgentDecisionContract,
  issues: ExecutionAgentDecisionValidationIssue[],
): ExecutionAgentDecisionPresentation {
  const acknowledgement = contract.includeAcknowledgement
    ? validateBoundedText({
        value: record.acknowledgement,
        minimumLength: 2,
        maximumLength: EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
        code: "execution_agent_acknowledgement_invalid",
        path: "decision.acknowledgement",
        label: "Acknowledgement",
        issues,
      })
    : undefined;
  const title = contract.includeTitle
    ? validateBoundedText({
        value: record.title,
        minimumLength: 2,
        maximumLength: EXECUTION_AGENT_TITLE_MAX_LENGTH,
        code: "execution_agent_title_invalid",
        path: "decision.title",
        label: "Title",
        issues,
      })
    : undefined;
  return {
    ...(contract.includeAcknowledgement && acknowledgement !== undefined
      ? { acknowledgement }
      : {}),
    ...(contract.includeTitle && title !== undefined ? { title } : {}),
  };
}

function presentationKeys(
  contract: PreparedExecutionAgentDecisionContract,
): readonly string[] {
  return [
    ...(contract.includeAcknowledgement ? ["acknowledgement"] : []),
    ...(contract.includeTitle ? ["title"] : []),
  ];
}

function exactPresentationKeys(
  record: Record<string, unknown>,
  contract: PreparedExecutionAgentDecisionContract,
  actionKeys: readonly string[],
  issues: ExecutionAgentDecisionValidationIssue[],
): void {
  exactKeys(
    record,
    [...actionKeys, ...presentationKeys(contract)],
    issues,
    "decision",
  );
}

function validateObjective(
  value: unknown,
  issues: ExecutionAgentDecisionValidationIssue[],
): string | undefined {
  return validateBoundedText({
    value,
    maximumLength: EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH,
    code: "execution_agent_objective_invalid",
    path: "decision.objective",
    label: "Objective",
    issues,
  });
}

function parseBoundedTextArray(
  params: Readonly<{
    value: unknown;
    path: string;
    code: string;
    label: string;
    itemMaximumLength: number;
    maximumItems: number;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): readonly string[] | undefined {
  if (
    !Array.isArray(params.value) ||
    params.value.length < 1 ||
    params.value.length > params.maximumItems
  ) {
    params.issues.push(
      issue(
        params.code,
        params.path,
        `${params.label} must contain 1-${params.maximumItems} entries.`,
      ),
    );
    return undefined;
  }
  const normalized: string[] = [];
  params.value.forEach((value, index) => {
    const accepted = validateBoundedText({
      value,
      maximumLength: params.itemMaximumLength,
      code: params.code,
      path: `${params.path}.${index}`,
      label: params.label,
      issues: params.issues,
    });
    if (accepted !== undefined) normalized.push(accepted);
  });
  if (new Set(normalized).size !== normalized.length) {
    params.issues.push(
      issue(
        params.code,
        params.path,
        `${params.label} entries must be distinct.`,
      ),
    );
  }
  return normalized.length === params.value.length
    ? Object.freeze(normalized)
    : undefined;
}

function validateBoundedText(
  params: Readonly<{
    value: unknown;
    minimumLength?: number;
    maximumLength: number;
    code: string;
    path: string;
    label: string;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): string | undefined {
  const normalized =
    typeof params.value === "string" ? params.value.trim() : "";
  const minimumLength = params.minimumLength ?? 1;
  if (
    typeof params.value !== "string" ||
    normalized.length < minimumLength ||
    params.value.length > params.maximumLength
  ) {
    params.issues.push(
      issue(
        params.code,
        params.path,
        `${params.label} must be text of ${minimumLength}-${params.maximumLength} characters.`,
      ),
    );
    return undefined;
  }
  return normalized;
}

function normalizeGeneratedCapabilityControls(
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

function readAction(value: unknown): ExecutionAgentDecisionAction | undefined {
  return typeof value === "string" &&
    EXECUTION_AGENT_DECISION_ACTIONS.includes(
      value as ExecutionAgentDecisionAction,
    )
    ? (value as ExecutionAgentDecisionAction)
    : undefined;
}

function exactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  issues: ExecutionAgentDecisionValidationIssue[],
  path: string,
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(
      issue(
        "execution_agent_decision_shape_invalid",
        path,
        "Decision fields must exactly match the selected action.",
      ),
    );
  }
}

function capabilityControlsIssue(
  params: Readonly<{
    issueCode: string;
    controlId?: string;
    path: string;
  }>,
): ExecutionAgentDecisionValidationIssue {
  return issue(
    `execution_agent_capability_${params.issueCode}`,
    params.path,
    params.controlId
      ? `Capability control ${JSON.stringify(params.controlId)} failed ${params.issueCode}.`
      : `Capability controls failed ${params.issueCode}.`,
  );
}

function rejectEnvelope(
  issues: readonly ExecutionAgentDecisionValidationIssue[],
): ExecutionAgentDecisionParseResult {
  return {
    ok: false,
    stage: "json_envelope",
    issues: Object.freeze([...issues]),
  };
}

function issue(
  code: string,
  path: string,
  message: string,
): ExecutionAgentDecisionValidationIssue {
  return { code, path, message };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
