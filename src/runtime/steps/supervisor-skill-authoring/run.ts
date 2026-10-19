import { invokeStructuredModelStep } from "../../model/invoke-structured-step.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "../supervisor-decision/contracts.js";
import { parseSupervisorSkillAuthoringOutput } from "./contract.js";
import { buildSupervisorSkillAuthoringInput, type SupervisorSkillAuthoringInputOptions } from "./input.js";

export async function runSupervisorSkillAuthoring(
  request: RequestExecutionScope,
  options: SupervisorSkillAuthoringInputOptions & Readonly<{
    boundSteeringVersion: number;
    contextCompaction: ModelStepContextCompactionController;
  }>,
) {
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
  const diagnostic = { ...options.diagnostic, decisionPhase: "skill_authoring" as const };
  const input = buildSupervisorSkillAuthoringInput(request, { ...options, diagnostic });
  const startedAt = Date.now();
  traceDebug("runtime.supervisor", "model.started", {
    ...diagnostic, outputContract: input.format.name, messageCount: input.context.messages.length,
  });
  const accepted = await invokeStructuredModelStep({
    request, modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    format: input.format, messages: input.context.messages,
    boundSteeringVersion: options.boundSteeringVersion,
    contextCompaction: options.contextCompaction,
    timeoutReason: "supervisor_decision_timeout", invalidOutputReason: "invalid_supervisor_skill_authoring",
    parse(text) {
      const parsed = parseSupervisorSkillAuthoringOutput(text, input.authoringOptions);
      if (!parsed.ok) return parsed;
      return { ok: true, decision: { decision: parsed.decision, steeringVersion: steering.snapshot().version } };
    },
  });
  assertBoundModelStepSteeringCurrent(steering, accepted.steeringVersion);
  traceDebug("runtime.supervisor", "model.completed", {
    ...diagnostic, selectedAction: accepted.decision.action, durationMs: Date.now() - startedAt,
  });
  return accepted;
}
