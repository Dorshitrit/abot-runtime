import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
} from "../../model/invoke-structured-step.js";
import { ROLE_CALL_RESULT_MAX_LENGTH } from "../../orchestration/role-calls/index.js";
import type { RoleExecutor } from "../../orchestration/role-executors/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import type { AuditorDecision } from "./contracts.js";
import { AUDITOR_DECISION_MODEL_STEP } from "./contracts.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { buildAuditorDecisionInput } from "./input.js";
import { parseAuditorDecisionOutput } from "./parser.js";

export const EXECUTION_AGENT_AUDITOR_EXECUTOR: RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = Object.freeze({
  roleId: "reviewer",
  async execute({ context, call, ledger, continuation }) {
    if (continuation) {
      return failedAdvisory("auditor_continuation_unsupported");
    }
    try {
      const input = buildAuditorDecisionInput(context, ledger.current(), call);
      const decision = await runAuditorDecision(context, input, {
        call,
        sourceRevision: ledger.current().revision,
      });
      const summary = JSON.stringify({
        kind: "runtime_execution_agent_auditor_advisory_v1",
        authority: "model_advisory",
        presenceEffect: "passive_result_not_execution_or_completion",
        ...decision,
      });
      if (summary.length > ROLE_CALL_RESULT_MAX_LENGTH) {
        return failedAdvisory("auditor_result_not_admissible");
      }
      return Object.freeze({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary,
      });
    } catch (error: unknown) {
      if (error instanceof StructuredModelInvalidOutputError) {
        return failedAdvisory("invalid_auditor_decision");
      }
      throw error;
    }
  },
});

async function runAuditorDecision(
  request: RequestExecutionScope,
  input: ReturnType<typeof buildAuditorDecisionInput>,
  options: Readonly<{
    call: Parameters<typeof createModelStepCompactionController>[1]["call"];
    sourceRevision: number;
  }>,
): Promise<AuditorDecision> {
  return invokeStructuredModelStep({
    request,
    modelStep: input.modelStep,
    format: input.format,
    messages: input.context.messages,
    contextCompaction: createModelStepCompactionController(request, {
      call: options.call,
      sourceRevision: options.sourceRevision,
      allowedConsumers: Object.freeze([AUDITOR_DECISION_MODEL_STEP]),
    }),
    timeoutReason: "auditor_decision_timeout",
    invalidOutputReason: "invalid_auditor_decision",
    parse: (text) => parseAuditorDecisionOutput(text, input.assignment),
  });
}

function failedAdvisory(reason: string) {
  return Object.freeze({
    kind: "terminal" as const,
    outcome: "failed" as const,
    summary: JSON.stringify({
      kind: "runtime_execution_agent_auditor_advisory_v1",
      authority: "runtime_validation",
      presenceEffect: "passive_result_not_execution_or_completion",
      outcome: "invalid",
      reason,
    }),
  });
}
