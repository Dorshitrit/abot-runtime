import {
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallPolicyInput,
} from "../orchestration/role-calls/index.js";
import type { CompiledRequestExecutionPolicy } from "./execution-scope.js";

const REQUEST_ROLE_CALL_LIMITS = Object.freeze({
  maxDepth: 12,
  maxCalls: 48,
  maxCapabilityExecutions: 96,
  maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
  maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
});

/** The same canonical policy binds fresh execution and approval hydration. */
export function createRequestRoleCallPolicy(
  policy: CompiledRequestExecutionPolicy,
): RoleCallPolicyInput {
  return Object.freeze({
    authority: policy.authority,
    limits: REQUEST_ROLE_CALL_LIMITS,
  });
}
