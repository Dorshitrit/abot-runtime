import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH } from "./direct-response-contract.js";
import { hasCompatibleDirectResponseConfiguration } from "./direct-response-configuration.js";
import type { ExecutionMemoryProjection } from "../../long-term-memory/initial-context.js";

/** Request-local offer only; neither prompt classification nor permission to omit required work. */
export function resolveDirectResponseOffer(
  request: RequestExecutionScope,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): Readonly<{ reason: string; maxLength?: number }> {
  if (request.automationOutputContract)
    return { reason: "automation_output_contract" };
  if (request.scheduledExecution) return { reason: "scheduled_execution" };
  if (request.sessionKind === "spark") return { reason: "spark_session" };
  if (head.state.capabilityExecutions.length > 0)
    return { reason: "capability_work" };
  if (head.state.calls.length !== 1) return { reason: "delegated_work" };
  if (head.state.results.length > 0) return { reason: "subordinate_results" };
  if (call.adoptedWorkPlan) return { reason: "work_plan" };
  if (!hasCompatibleDirectResponseConfiguration(request))
    return { reason: "response_configuration" };
  return {
    reason: "eligible",
    maxLength: Math.min(
      EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH,
      head.policy.limits.maxResponseChars,
    ),
  };
}

export function canAuthorDirectResponseMemory(
  maxLength: number | undefined,
  memory: ExecutionMemoryProjection | undefined,
): memory is ExecutionMemoryProjection {
  if (maxLength === undefined) return false;
  return memory?.authoringEnabled === true;
}
