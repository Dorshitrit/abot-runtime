import { createCapabilityBriefReadmissionController } from "../../context/capability-brief-readmission.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { buildSupervisorCapabilityBriefOptions } from "./capability-brief.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "./contracts.js";
import type { buildSupervisorDecisionInput } from "./input.js";

type BriefRoutingInput = Pick<
  ReturnType<typeof buildSupervisorDecisionInput>,
  "format" | "allowedRoleIds" | "availableWorkerCapabilityCatalog"
>;

/** Optional routing metadata yields capacity to actual repair and steering. */
export function createSupervisorCapabilityBriefReadmissionController(
  request: RequestExecutionScope,
  options: Readonly<{
    input: BriefRoutingInput;
    controller: ModelStepContextCompactionController;
  }>,
): ModelStepContextCompactionController {
  const { input, controller } = options;
  return createCapabilityBriefReadmissionController({
    controller,
    resolveOptions() {
      const admission = resolveModelContextAdmission({
        runnerConfig: request.runnerConfig,
        agentMode: request.agentMode,
        modelStep: SUPERVISOR_DECISION_MODEL_STEP,
        modelPreference: request.modelPreference,
        modelPolicy: request.modelPolicy,
        requestFormat: input.format,
      });
      const briefOptions = buildSupervisorCapabilityBriefOptions(
        request,
        input,
      );
      return {
        entries: briefOptions.capabilityBriefEntries,
        groups: input.availableWorkerCapabilityCatalog,
        budget: admission.budget,
        format: input.format,
        additionalBudgetMessages: briefOptions.capabilityBriefBudgetMessages,
      };
    },
    onReadmitted(replacement) {
      traceDebug("runtime.supervisor", "capability_brief.readmitted", {
        requestId: request.requestId,
        level: replacement.level,
        estimatedTokens: replacement.estimatedTokens,
        budgetTokens: replacement.budgetTokens,
        reason: replacement.reason,
      });
    },
  });
}
