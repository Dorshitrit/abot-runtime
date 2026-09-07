import {
  isSupervisorDelegateRoleId,
  SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
  SUPERVISOR_DECISION_ACTIONS,
  SUPERVISOR_DELEGATE_ROLE_IDS,
  SUPERVISOR_OBJECTIVE_MAX_LENGTH,
  SUPERVISOR_TITLE_MAX_LENGTH,
  type SupervisorDecisionDiagnosticContext,
  type SupervisorRoutingDecision,
  type SupervisorRoutingDecisionParseResult,
  type SupervisorDecisionValidationIssue,
  type SupervisorDelegateRoleId,
} from "./contracts.js";
import type { RoleCallWorkerCapabilityScope } from "../../orchestration/role-calls/index.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import {
  createWorkerCapabilityScopeDecisionContract,
  parseWorkerCapabilityScopeDecision,
  type WorkerCapabilityScopeDecisionContract,
} from "../worker-capability-scope-decision.js";
import {
  traceSupervisorAcknowledgementNormalized,
  traceSupervisorDecisionAccepted,
  traceSupervisorDecisionRejected,
  traceSupervisorEnvelopeAccepted,
  traceSupervisorEnvelopeRejected,
} from "./diagnostics.js";
import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import {
  isMemoryRecallDecisionRecord,
  parseMemoryRecallDecision,
} from "../memory-recall-decision.js";
import {
  projectSupervisorResponseRecommendation,
  supervisorResponseRecommendationKeys,
} from "./response-recommendation.js";

export function parseSupervisorDecisionOutput(
  text: string,
  options: Readonly<{
    includeAcknowledgement?: boolean;
    includeTitle?: boolean;
    includeResponseRecommendation?: boolean;
    allowMemoryRecall?: boolean;
    allowedRoleIds?: readonly SupervisorDelegateRoleId[];
    availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
    diagnostic?: SupervisorDecisionDiagnosticContext;
  }> = {},
): SupervisorRoutingDecisionParseResult {
  const includeAcknowledgement = options.includeAcknowledgement === true;
  const includeTitle = options.includeTitle === true;
  const includeResponseRecommendation =
    options.includeResponseRecommendation === true;
  const allowedRoleIds = [
    ...new Set(options.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS),
  ];
  const workerCapabilityScopeContract =
    createWorkerCapabilityScopeDecisionContract(
      options.availableWorkerCapabilityCatalog ?? [],
    );
  const diagnostic = options.diagnostic;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectEnvelope(
      text.length,
      [
        issue(
          "supervisor_output_not_json",
          "decision",
          "Expected one JSON object.",
        ),
      ],
      diagnostic,
    );
  }

  if (!asRecord(decoded)) {
    return rejectEnvelope(
      text.length,
      [
        issue(
          "supervisor_output_not_object",
          "decision",
          "Expected one JSON object.",
        ),
      ],
      diagnostic,
    );
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record) {
    return rejectEnvelope(
      text.length,
      [
        issue(
          "supervisor_output_envelope_invalid",
          "decision",
          "Expected exactly one decision object inside the canonical envelope.",
        ),
      ],
      diagnostic,
    );
  }
  if (diagnostic) {
    traceSupervisorEnvelopeAccepted({
      diagnostic,
      outputLength: text.length,
      keyCount: Object.keys(record).length,
    });
  }

  const issues: SupervisorDecisionValidationIssue[] = [];
  if (isMemoryRecallDecisionRecord(record)) {
    const recalled = parseMemoryRecallDecision(record, {
      allowMemoryRecall: options.allowMemoryRecall,
      includeAcknowledgement,
      includeTitle,
      acknowledgementMaxLength: SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
      titleMaxLength: SUPERVISOR_TITLE_MAX_LENGTH,
    });
    if (!diagnostic) return recalled;
    if (!recalled.ok) {
      traceSupervisorDecisionRejected({
        diagnostic,
        selectedAction: "recall_memory",
        issues: recalled.issues,
      });
      return recalled;
    }
    traceSupervisorDecisionAccepted({
      diagnostic,
      decision: recalled.decision,
    });
    return recalled;
  }
  let normalizedAcknowledgement: string | undefined;
  let acknowledgementOriginalLength: number | undefined;
  let workerCapabilityScope: RoleCallWorkerCapabilityScope | undefined;
  const selectedAction =
    record.action === "respond" || record.action === "invoke_role"
      ? record.action
      : undefined;

  if (!selectedAction) {
    issues.push(
      issue(
        "supervisor_action_invalid",
        "decision.action",
        `Action must be one of: ${SUPERVISOR_DECISION_ACTIONS.join(", ")}.`,
      ),
    );
  } else if (selectedAction === "respond") {
    exactKeys(
      record,
      [
        "action",
        ...supervisorResponseRecommendationKeys(
          record,
          includeResponseRecommendation,
        ),
        ...(includeAcknowledgement ? ["acknowledgement"] : []),
        ...(includeTitle ? ["title"] : []),
      ],
      issues,
    );
  } else {
    const reviewerInvocationSelected = record.roleId === "reviewer";
    exactKeys(
      record,
      [
        "action",
        "roleId",
        ...(reviewerInvocationSelected ? [] : ["objective"]),
        ...(record.roleId === "worker" && workerCapabilityScopeContract.required
          ? ["workerCapabilityScope"]
          : []),
        ...(includeAcknowledgement ? ["acknowledgement"] : []),
        ...(includeTitle ? ["title"] : []),
      ],
      issues,
    );
    if (
      !isSupervisorDelegateRoleId(record.roleId) ||
      !allowedRoleIds.includes(record.roleId)
    ) {
      issues.push(
        issue(
          "supervisor_role_invalid",
          "decision.roleId",
          "roleId must identify one available non-Supervisor role.",
        ),
      );
    }
    if (!reviewerInvocationSelected) {
      validateBoundedText({
        value: record.objective,
        maximumLength: SUPERVISOR_OBJECTIVE_MAX_LENGTH,
        code: "supervisor_objective_invalid",
        path: "decision.objective",
        label: "Objective",
        issues,
      });
    }
    if (record.roleId === "worker" && workerCapabilityScopeContract.required) {
      workerCapabilityScope = parseSupervisorWorkerCapabilityScope(
        record.workerCapabilityScope,
        workerCapabilityScopeContract,
        issues,
      );
    }
  }
  if (includeAcknowledgement) {
    const acknowledgement = normalizeAcknowledgement(
      record.acknowledgement,
      issues,
    );
    normalizedAcknowledgement = acknowledgement.value;
    acknowledgementOriginalLength = acknowledgement.originalLength;
  }
  if (includeTitle) {
    validateBoundedText({
      value: record.title,
      minimumLength: 2,
      maximumLength: SUPERVISOR_TITLE_MAX_LENGTH,
      code: "supervisor_title_invalid",
      path: "decision.title",
      label: "Title",
      issues,
    });
  }

  if (issues.length > 0 || !selectedAction) {
    if (diagnostic) {
      traceSupervisorDecisionRejected({
        diagnostic,
        issues,
        ...(selectedAction ? { selectedAction } : {}),
      });
    }
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }

  const decision = buildAcceptedSupervisorRoutingDecision({
    record,
    selectedAction,
    includeAcknowledgement,
    includeTitle,
    includeResponseRecommendation,
    normalizedAcknowledgement,
    workerCapabilityScope,
  });
  const accepted = deepFreeze(structuredClone(decision));
  if (diagnostic) {
    if (acknowledgementOriginalLength !== undefined) {
      traceSupervisorAcknowledgementNormalized({
        diagnostic,
        originalLength: acknowledgementOriginalLength,
        normalizedLength: normalizedAcknowledgement?.length ?? 0,
        maximumLength: SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
      });
    }
    traceSupervisorDecisionAccepted({ diagnostic, decision: accepted });
  }
  return { ok: true, decision: accepted };
}

function buildAcceptedSupervisorRoutingDecision(params: {
  record: Record<string, unknown>;
  selectedAction: "invoke_role" | "respond";
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  includeResponseRecommendation: boolean;
  normalizedAcknowledgement?: string;
  workerCapabilityScope?: RoleCallWorkerCapabilityScope;
}): SupervisorRoutingDecision {
  const presentation = {
    ...(params.includeAcknowledgement
      ? { acknowledgement: params.normalizedAcknowledgement as string }
      : {}),
    ...(params.includeTitle
      ? { title: (params.record.title as string).trim() }
      : {}),
  };
  if (params.selectedAction === "respond") {
    return {
      action: "respond",
      ...presentation,
      ...(params.includeResponseRecommendation
        ? projectSupervisorResponseRecommendation(
            params.record.responseRecommendation,
          )
        : {}),
    };
  }
  const objective = (params.record.objective as string | undefined)?.trim();
  if (params.record.roleId === "worker") {
    return {
      action: "invoke_role",
      roleId: "worker",
      objective: objective as string,
      ...(params.workerCapabilityScope
        ? { workerCapabilityScope: params.workerCapabilityScope }
        : {}),
      ...presentation,
    };
  }
  if (params.record.roleId === "planner") {
    return {
      action: "invoke_role",
      roleId: "planner",
      objective: objective as string,
      ...presentation,
    };
  }
  if (params.record.roleId === "reviewer") {
    return { action: "invoke_role", roleId: "reviewer", ...presentation };
  }
  return {
    action: "invoke_role",
    roleId: params.record.roleId as Exclude<
      SupervisorDelegateRoleId,
      "planner" | "reviewer" | "worker"
    >,
    objective: objective as string,
    ...presentation,
  };
}

function parseSupervisorWorkerCapabilityScope(
  value: unknown,
  contract: WorkerCapabilityScopeDecisionContract,
  issues: SupervisorDecisionValidationIssue[],
): RoleCallWorkerCapabilityScope | undefined {
  const parsed = parseWorkerCapabilityScopeDecision(value, contract);
  if (!parsed) {
    issues.push(
      issue(
        "supervisor_worker_capability_scope_invalid",
        "decision.workerCapabilityScope.catalogGroupIds",
        "workerCapabilityScope.catalogGroupIds must contain one or more distinct available catalog group IDs.",
      ),
    );
    return undefined;
  }
  return parsed;
}

function normalizeAcknowledgement(
  value: unknown,
  issues: SupervisorDecisionValidationIssue[],
): Readonly<{ value?: string; originalLength?: number }> {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (typeof value !== "string" || normalized.length < 2) {
    issues.push(
      issue(
        "supervisor_acknowledgement_invalid",
        "decision.acknowledgement",
        `Acknowledgement must be text of 2-${SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH} characters.`,
      ),
    );
    return {};
  }
  if (normalized.length <= SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH) {
    return { value: normalized };
  }
  return {
    value: truncateWithEllipsis(
      normalized,
      SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
    ),
    originalLength: normalized.length,
  };
}

function truncateWithEllipsis(value: string, maximumLength: number): string {
  const ellipsis = "…";
  let result = "";
  for (const character of value) {
    if (result.length + character.length + ellipsis.length > maximumLength) {
      break;
    }
    result += character;
  }
  return `${result.trimEnd()}${ellipsis}`;
}

function rejectEnvelope(
  outputLength: number,
  issues: readonly SupervisorDecisionValidationIssue[],
  diagnostic?: SupervisorDecisionDiagnosticContext,
): SupervisorRoutingDecisionParseResult {
  if (diagnostic) {
    traceSupervisorEnvelopeRejected({
      diagnostic,
      outputLength,
      issues,
    });
  }
  return {
    ok: false,
    stage: "json_envelope",
    issues: Object.freeze([...issues]),
  };
}

function exactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  issues: SupervisorDecisionValidationIssue[],
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(
      issue(
        "supervisor_decision_shape_invalid",
        "decision",
        "Decision fields must exactly match the selected action.",
      ),
    );
  }
}

function validateBoundedText(params: {
  value: unknown;
  minimumLength?: number;
  maximumLength: number;
  code: string;
  path: string;
  label: string;
  issues: SupervisorDecisionValidationIssue[];
}): void {
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
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(
  code: string,
  path: string,
  message: string,
): SupervisorDecisionValidationIssue {
  return { code, path, message };
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
