import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
} from "../../model/invoke-structured-step.js";
import { emitRuntimeStatus } from "../../events/runtime-status.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import {
  projectRequestToolResults,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RoleExecutor } from "../../orchestration/role-executors/index.js";
import type { RuntimeDelegateRoleId } from "../../orchestration/roles.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import {
  PLANNER_DECISION_MODEL_STEP,
  type PlannerDecision,
  type PlannerDecisionDiagnosticContext,
  type PlannerDecisionPlanContext,
} from "./contracts.js";
import {
  tracePlannerModelCompleted,
  tracePlannerModelFailed,
  tracePlannerModelStarted,
} from "./diagnostics.js";
import {
  buildPlannerDecisionInput,
  type PlannerDecisionProgressSource,
} from "./input.js";
import { parsePlannerDecisionOutput } from "./parser.js";
import { projectPlannerDecisionPlanContext } from "./plan.js";
import { PLANNER_GRAPH_MODEL_STEP } from "../planner-graph/contracts.js";

type RunPlannerDecisionOptions = Readonly<{
  call: RoleCallFrame;
  availableChildRoleIds: readonly RuntimeDelegateRoleId[];
  toolResults: RequestToolResultsView;
  dependencyHead?: RoleCallLedgerHead;
  progress?: PlannerDecisionProgressSource;
  planContext?: PlannerDecisionPlanContext;
}>;

export async function runPlannerDecision(
  request: RequestExecutionScope,
  options: RunPlannerDecisionOptions,
): Promise<PlannerDecision> {
  const input = buildPlannerDecisionInput(request, options);
  const diagnostic: PlannerDecisionDiagnosticContext = input.diagnostic;
  const startedAt = Date.now();

  tracePlannerModelStarted({
    diagnostic,
    messageCount: input.context.messages.length,
    messageCharacterCount: input.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    allowedActions: input.allowedActions,
  });

  try {
    const decision = await invokeStructuredModelStep({
      request,
      modelStep: input.modelStep,
      format: input.format,
      messages: input.context.messages,
      contextCompaction: createModelStepCompactionController(request, {
        call: options.call,
        sourceRevision: options.toolResults.sourceRevision,
        allowedConsumers: Object.freeze([
          PLANNER_DECISION_MODEL_STEP,
          PLANNER_GRAPH_MODEL_STEP,
        ]),
      }),
      timeoutReason: "planner_decision_timeout",
      invalidOutputReason: "invalid_planner_decision",
      parse: (text) =>
        parsePlannerDecisionOutput(text, {
          availableChildRoleIds: input.availableChildRoleIds,
          availableWorkerCapabilityCatalog:
            input.availableWorkerCapabilityCatalog,
          ...(input.inheritedWorkingDirectory !== undefined
            ? {
                inheritedWorkingDirectory: input.inheritedWorkingDirectory,
              }
            : {}),
          ...(input.planContext ? { planContext: input.planContext } : {}),
          diagnostic,
        }),
    });
    tracePlannerModelCompleted({
      diagnostic,
      decision,
      durationMs: Date.now() - startedAt,
      ...(decision.action === "invoke_role" && decision.roleId === "worker"
        ? {
            workingDirectorySource:
              input.inheritedWorkingDirectory === undefined
                ? ("model" as const)
                : ("inherited" as const),
          }
        : {}),
    });
    return decision;
  } catch (error: unknown) {
    tracePlannerModelFailed({
      diagnostic,
      durationMs: Date.now() - startedAt,
      errorType: classifyRuntimeErrorType(error),
      invalidStructuredOutput:
        error instanceof StructuredModelInvalidOutputError,
    });
    throw error;
  }
}

export const GENERIC_PLANNER_EXECUTOR: RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = Object.freeze({
  roleId: "planner",
  async execute({
    context,
    call,
    ledger,
    availableChildRoleIds,
    continuation,
  }) {
    if (continuation && continuation.kind !== "role_child") {
      throw new Error("planner_capability_continuation_unsupported");
    }
    emitRuntimeStatus(context, {
      stage: "planner",
      phase: "planning",
      message: "Planning the delegated work...",
    });
    const head = ledger.current();
    const toolResults = projectRequestToolResults({
      ledger,
      head,
      modelStep: PLANNER_DECISION_MODEL_STEP,
      callId: call.callId,
    });
    const planContext = projectPlannerDecisionPlanContext({
      ledger,
      call,
    });
    const decision = await runPlannerDecision(context, {
      call,
      availableChildRoleIds,
      toolResults,
      dependencyHead: head,
      planContext,
      ...(continuation
        ? {
            progress: {
              kind: "role_child" as const,
              ledger,
              commit: continuation.commit,
            },
          }
        : {}),
    });
    if (decision.action === "return_result") {
      return Object.freeze({
        kind: "terminal",
        outcome: "completed",
        summary: decision.result,
      });
    }
    if (decision.action === "return_failure") {
      return Object.freeze({
        kind: "terminal",
        outcome: "failed",
        summary: decision.reason,
      });
    }
    return Object.freeze({
      kind: "invoke_role",
      roleId: decision.roleId,
      objective: decision.objective,
      ...(decision.roleId === "worker"
        ? {
            workingDirectory:
              call.workingDirectory ?? decision.workingDirectory,
          }
        : {}),
      ...(decision.roleId === "worker" && decision.workerCapabilityScope
        ? { workerCapabilityScope: decision.workerCapabilityScope }
        : {}),
      ...(decision.plannerPlan ? { plannerPlan: decision.plannerPlan } : {}),
    });
  },
});
