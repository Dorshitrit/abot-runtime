import type { ChatMessage } from "../../../model-gateway/types.js";
import { createCapabilityBriefReadmissionController } from "../../context/capability-brief-readmission.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import { resolveRequestCapabilityBriefEntries } from "../../request/capability-brief.js";
import type { RequestWorkerCapabilityProviderSource } from "../../request/execution-scope.js";
import { PLANNER_DECISION_MODEL_STEP } from "./contracts.js";
import type { buildPlannerDecisionInput } from "./input.js";

type BriefRequest = Omit<
  Parameters<typeof resolveModelContextAdmission>[0],
  "modelStep"
> &
  RequestWorkerCapabilityProviderSource;

/** Planner delegation uses the same request-registry facts as Supervisor. */
export function buildPlannerCapabilityBriefOptions(
  request: BriefRequest,
  groups: readonly WorkerCapabilityCatalogGroup[],
) {
  const admission = resolveModelContextAdmission({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: PLANNER_DECISION_MODEL_STEP,
    modelPreference: request.modelPreference,
    modelPolicy: request.modelPolicy,
  });
  const instructions = (admission.invocation.instructions ?? [])
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0);
  const additionalBudgetMessages: readonly ChatMessage[] =
    instructions.length > 0
      ? [{ role: "system", content: instructions.join("\n") }]
      : [];
  return Object.freeze({
    entries: resolveRequestCapabilityBriefEntries(
      request.workerCapabilities,
      groups,
    ),
    groups,
    budget: admission.budget,
    // Root steering is deliberately not inherited by this bounded child.
    additionalBudgetMessages,
  });
}

/** Reuses optional-brief admission without inheriting root steering authority. */
export function createPlannerCapabilityBriefReadmissionController(
  request: BriefRequest & { requestId: string },
  options: Readonly<{
    input: Pick<
      ReturnType<typeof buildPlannerDecisionInput>,
      "format" | "availableWorkerCapabilityCatalog"
    >;
    controller: ModelStepContextCompactionController;
  }>,
): ModelStepContextCompactionController {
  return createCapabilityBriefReadmissionController({
    controller: options.controller,
    resolveOptions: () => ({
      ...buildPlannerCapabilityBriefOptions(
        request,
        options.input.availableWorkerCapabilityCatalog,
      ),
      format: options.input.format,
    }),
    onReadmitted: (brief) => {
      traceDebug("runtime.planner", "capability_brief.readmitted", {
        requestId: request.requestId,
        level: brief.level,
        estimatedTokens: brief.estimatedTokens,
        budgetTokens: brief.budgetTokens,
        reason: brief.reason,
      });
    },
  });
}
