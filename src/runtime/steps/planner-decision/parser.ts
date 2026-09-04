import {
  normalizeRoleCallWorkingDirectory,
  type RoleCallPlanBinding,
  type RoleCallWorkerCapabilityScope,
} from "../../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../../orchestration/roles.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import {
  createWorkerCapabilityScopeDecisionContract,
  parseWorkerCapabilityScopeDecision,
  type WorkerCapabilityScopeDecisionContract,
} from "../worker-capability-scope-decision.js";
import {
  PLANNER_DECISION_ACTIONS,
  PLANNER_OBJECTIVE_MAX_LENGTH,
  PLANNER_RESULT_MAX_LENGTH,
  type PlannerDecision,
  type PlannerDecisionDiagnosticContext,
  type PlannerDecisionPlanContext,
  type PlannerDecisionParseResult,
  type PlannerDecisionSelectionKind,
  type PlannerDecisionValidationIssue,
  type PlannerChildRoleId,
} from "./contracts.js";
import {
  tracePlannerDecisionAccepted,
  tracePlannerDecisionRejected,
  tracePlannerEnvelopeAccepted,
  tracePlannerEnvelopeRejected,
} from "./diagnostics.js";
import { normalizeAvailableChildRoleIds } from "./format.js";
import {
  normalizePlannerDecisionPlanContext,
  plannerPlanAllowsInvocation,
} from "./plan.js";
import { parsePlannerPlanInvocation } from "./plan-parser.js";
import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";

export function parsePlannerDecisionOutput(
  text: string,
  options: Readonly<{
    availableChildRoleIds?: readonly RuntimeDelegateRoleId[];
    availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
    inheritedWorkingDirectory?: string;
    planContext?: PlannerDecisionPlanContext;
    diagnostic?: PlannerDecisionDiagnosticContext;
  }> = {},
): PlannerDecisionParseResult {
  const availableChildRoleIds = normalizeAvailableChildRoleIds(
    options.availableChildRoleIds ?? [],
  );
  const availableWorkerCapabilityCatalog =
    options.availableWorkerCapabilityCatalog ?? [];
  const inheritedWorkingDirectory = options.inheritedWorkingDirectory;
  if (
    inheritedWorkingDirectory !== undefined &&
    normalizeRoleCallWorkingDirectory(inheritedWorkingDirectory) !==
      inheritedWorkingDirectory
  ) {
    throw new Error("planner_inherited_working_directory_invalid");
  }
  const workerCapabilityScopeContract =
    createWorkerCapabilityScopeDecisionContract(
      availableWorkerCapabilityCatalog,
    );
  const planContext = options.planContext
    ? normalizePlannerDecisionPlanContext(options.planContext)
    : undefined;
  const diagnostic = options.diagnostic;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectEnvelope(
      text.length,
      [issue("planner_output_not_json", "decision")],
      diagnostic,
    );
  }

  if (!asRecord(decoded)) {
    return rejectEnvelope(
      text.length,
      [issue("planner_output_not_object", "decision")],
      diagnostic,
    );
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record) {
    return rejectEnvelope(
      text.length,
      [issue("planner_output_envelope_invalid", "decision")],
      diagnostic,
    );
  }
  if (diagnostic) {
    tracePlannerEnvelopeAccepted({
      diagnostic,
      outputLength: text.length,
      keyCount: Object.keys(record).length,
    });
  }

  const issues: PlannerDecisionValidationIssue[] = [];
  let invocation:
    | Readonly<{
        objective: string;
        plannerPlan?: RoleCallPlanBinding;
      }>
    | undefined;
  let workerCapabilityScope: RoleCallWorkerCapabilityScope | undefined;
  let workingDirectory = inheritedWorkingDirectory;
  const selectedAction =
    record.action === "return_result" ||
    record.action === "return_failure" ||
    record.action === "invoke_role"
      ? record.action
      : undefined;
  const selectedKind: PlannerDecisionSelectionKind | undefined = selectedAction;

  if (!selectedAction) {
    issues.push(issue("planner_action_invalid", "decision.action"));
  } else if (selectedAction === "return_result") {
    exactKeys(record, ["action", "result"], issues);
    if (planContext?.mode === "select") {
      issues.push(issue("planner_plan_incomplete", "decision.action"));
    }
    validateBoundedText(
      record.result,
      PLANNER_RESULT_MAX_LENGTH,
      "planner_result_invalid",
      "decision.result",
      issues,
    );
  } else if (selectedAction === "return_failure") {
    exactKeys(record, ["action", "reason"], issues);
    validateBoundedText(
      record.reason,
      PLANNER_RESULT_MAX_LENGTH,
      "planner_result_invalid",
      "decision.reason",
      issues,
    );
  } else {
    exactKeys(
      record,
      [
        "action",
        "roleId",
        ...(planContext?.mode === "declare"
          ? ["plan", "selectedItemIndexes"]
          : planContext?.mode === "extend"
            ? ["extension", "selectedItemIndexes"]
            : planContext?.mode === "select"
              ? ["planItemIds"]
              : ["objective"]),
        ...(record.roleId === "worker" && workerCapabilityScopeContract.required
          ? ["workerCapabilityScope"]
          : []),
        ...(record.roleId === "worker" &&
        inheritedWorkingDirectory === undefined
          ? ["workingDirectory"]
          : []),
      ],
      issues,
    );
    if (
      typeof record.roleId !== "string" ||
      !availableChildRoleIds.includes(record.roleId as PlannerChildRoleId)
    ) {
      issues.push(issue("planner_child_role_unavailable", "decision.roleId"));
    }
    if (!plannerPlanAllowsInvocation(planContext)) {
      issues.push(
        issue("planner_child_invocation_unavailable", "decision.action"),
      );
    }
    invocation = parsePlannerInvocation(record, planContext, issues);
    if (
      record.roleId === "worker" &&
      inheritedWorkingDirectory === undefined &&
      record.workingDirectory !== undefined
    ) {
      workingDirectory = normalizeRoleCallWorkingDirectory(
        record.workingDirectory,
      );
      if (!workingDirectory) {
        issues.push(
          issue(
            "planner_working_directory_invalid",
            "decision.workingDirectory",
          ),
        );
      }
    }
    if (record.roleId === "worker" && workerCapabilityScopeContract.required) {
      workerCapabilityScope = parsePlannerWorkerCapabilityScope(
        record.workerCapabilityScope,
        workerCapabilityScopeContract,
        issues,
      );
    }
  }
  if (
    issues.length > 0 ||
    !selectedKind ||
    (selectedAction === "invoke_role" &&
      (!invocation ||
        (record.roleId === "worker" && !workingDirectory) ||
        (record.roleId === "worker" &&
          workerCapabilityScopeContract.required &&
          !workerCapabilityScope)))
  ) {
    if (diagnostic) {
      tracePlannerDecisionRejected({
        diagnostic,
        issues,
        ...(selectedKind ? { selectedAction: selectedKind } : {}),
      });
    }
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }

  const decision: PlannerDecision =
    selectedAction === "return_result"
      ? {
          action: "return_result",
          result: (record.result as string).trim(),
        }
      : selectedAction === "return_failure"
        ? {
            action: "return_failure",
            reason: (record.reason as string).trim(),
          }
        : {
            action: "invoke_role",
            roleId: "worker",
            objective: invocation!.objective,
            workingDirectory: workingDirectory!,
            ...(workerCapabilityScope ? { workerCapabilityScope } : {}),
            ...(invocation!.plannerPlan
              ? { plannerPlan: invocation!.plannerPlan }
              : {}),
          };
  const accepted = deepFreeze(structuredClone(decision));
  if (diagnostic) {
    tracePlannerDecisionAccepted({
      diagnostic,
      decision: accepted,
      ...(accepted.action === "invoke_role" && accepted.roleId === "worker"
        ? {
            workingDirectorySource:
              inheritedWorkingDirectory === undefined
                ? ("model" as const)
                : ("inherited" as const),
          }
        : {}),
    });
  }
  return { ok: true, decision: accepted };
}

function parsePlannerInvocation(
  record: Record<string, unknown>,
  planContext: PlannerDecisionPlanContext | undefined,
  issues: PlannerDecisionValidationIssue[],
):
  | Readonly<{
      objective: string;
      plannerPlan?: RoleCallPlanBinding;
    }>
  | undefined {
  if (planContext) {
    return parsePlannerPlanInvocation(record, planContext, issues);
  }
  validateBoundedText(
    record.objective,
    PLANNER_OBJECTIVE_MAX_LENGTH,
    "planner_objective_invalid",
    "decision.objective",
    issues,
  );
  return typeof record.objective === "string" &&
    record.objective.trim().length > 0 &&
    record.objective.length <= PLANNER_OBJECTIVE_MAX_LENGTH
    ? { objective: record.objective.trim() }
    : undefined;
}

function parsePlannerWorkerCapabilityScope(
  value: unknown,
  contract: WorkerCapabilityScopeDecisionContract,
  issues: PlannerDecisionValidationIssue[],
): RoleCallWorkerCapabilityScope | undefined {
  const parsed = parseWorkerCapabilityScopeDecision(value, contract);
  if (!parsed) {
    issues.push(
      issue(
        "planner_worker_capability_scope_invalid",
        "decision.workerCapabilityScope.catalogGroupIds",
      ),
    );
    return undefined;
  }
  return parsed;
}

function rejectEnvelope(
  outputLength: number,
  issues: readonly PlannerDecisionValidationIssue[],
  diagnostic?: PlannerDecisionDiagnosticContext,
): PlannerDecisionParseResult {
  if (diagnostic) {
    tracePlannerEnvelopeRejected({ diagnostic, outputLength, issues });
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
  issues: PlannerDecisionValidationIssue[],
  path = "decision",
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(issue("planner_decision_shape_invalid", path));
  }
}

function validateBoundedText(
  value: unknown,
  maximumLength: number,
  code: string,
  path: string,
  issues: PlannerDecisionValidationIssue[],
): void {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    normalized.length === 0 ||
    value.length > maximumLength
  ) {
    issues.push(issue(code, path));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(code: string, path: string): PlannerDecisionValidationIssue {
  return {
    code,
    path,
    message:
      code === "planner_action_invalid"
        ? `Action must be one of: ${PLANNER_DECISION_ACTIONS.join(", ")}.`
        : `Planner decision failed ${code}.`,
  };
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
