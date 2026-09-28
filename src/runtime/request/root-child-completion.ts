import type {
  RoleCallLedger,
  RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import type { RoleChildInvocationResult } from "../orchestration/role-executors/contracts.js";
import type { RequestRoleExecutionHandoff } from "./result.js";
import type { CompiledRequestExecutionPolicy } from "./execution-scope.js";
import {
  bindSupervisorObservationHandoff,
  type RootObservationHandoff,
} from "./root-observation-handoff.js";
import type { SupervisorRootDiagnosticContext } from "./supervisor-root-execution-diagnostics.js";

/** Used by both a just-invoked child and an entered child from a saved wait. */
export function projectRootChildCompletion(params: {
  ledger: RoleCallLedger;
  policy: CompiledRequestExecutionPolicy;
  child: RoleChildInvocationResult<RequestRoleExecutionHandoff>;
  diagnostic: SupervisorRootDiagnosticContext;
  observationHandoff?: RootObservationHandoff;
}): Readonly<{
  resume: RoleChildReturnContext;
  observationHandoff?: RootObservationHandoff;
}> {
  const resume = params.policy.rootContract.projectResume(
    params.ledger,
    params.child.returnCommit,
  );
  const finalObservation = params.child.execution.value?.finalObservation;
  if (!finalObservation)
    return {
      resume,
      ...(params.observationHandoff
        ? { observationHandoff: params.observationHandoff }
        : {}),
    };
  return {
    resume,
    observationHandoff: bindSupervisorObservationHandoff({
      diagnostic: params.diagnostic,
      returnCommit: params.child.returnCommit,
      resume,
      finalObservation,
      replaced: params.observationHandoff !== undefined,
    }),
  };
}
