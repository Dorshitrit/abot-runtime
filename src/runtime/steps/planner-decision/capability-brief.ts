import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import { projectSupervisorWorkerCapabilityBriefEntries } from "../../orchestration/worker-capabilities/supervisor-skill-authority.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { createCapabilityBriefReadmissionController } from "../../context/capability-brief-readmission.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import { resolveRequestCapabilityBriefEntries } from "../../request/capability-brief.js";
import type { RequestExecutionScope, RequestWorkerCapabilityProviderSource } from "../../request/execution-scope.js";
import { PLANNER_DECISION_MODEL_STEP } from "./contracts.js";
import type { buildPlannerDecisionInput } from "./input.js";

type BriefRequest = Omit<
  Parameters<typeof resolveModelContextAdmission>[0],
  "modelStep"
> &
  RequestWorkerCapabilityProviderSource & Pick<RequestExecutionScope, "executionPolicy">;

/** Planner delegation uses the same request-registry facts as Supervisor. */
export function buildPlannerCapabilityBriefOptions(
  request: BriefRequest,
  groups: readonly WorkerCapabilityCatalogGroup[],
  steering?: RequestSteeringSnapshot,
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
  const configuredMessages: readonly ChatMessage[] = instructions.length > 0
    ? [{ role: "system", content: instructions.join("\n") }]
    : [];
  const additionalBudgetMessages = steering
    ? appendRequestSteeringContext(configuredMessages, steering)
    : configuredMessages;
  return Object.freeze({
    entries: projectSupervisorWorkerCapabilityBriefEntries({
      authority: request.executionPolicy.authority,
      entries: resolveRequestCapabilityBriefEntries(request.workerCapabilities, groups),
    }),
    groups,
    budget: admission.budget,
    // Only a canonical Worker handoff adds caller-owned steering to this budget.
    additionalBudgetMessages,
  });
}

/** Reuses optional-brief admission with the exact caller decision envelope. */
export function createPlannerCapabilityBriefReadmissionController(
  request: BriefRequest & { requestId: string },
  options: Readonly<{
    input: Pick<
      ReturnType<typeof buildPlannerDecisionInput>,
      "format" | "availableWorkerCapabilityCatalog" | "steering"
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
        options.input.steering,
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
