import type { RoleCallLedger } from "../orchestration/role-calls/index.js";
import {
  projectSupervisorCallIdentity,
  projectSupervisorResumeContext,
  runSupervisorDecision,
  SUPERVISOR_DECISION_MODEL_STEP,
} from "../steps/supervisor-decision/index.js";
import {
  runSupervisorResponse,
  SUPERVISOR_RESPONSE_MODEL_STEP,
} from "../steps/supervisor-response/index.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import type {
  RequestRunnerResult,
} from "./result.js";
import {
  runRootExecutionKernel,
  type RequestRootContractAdapter,
} from "./root-execution-kernel.js";

export const SUPERVISOR_ROOT_CONTRACT: RequestRootContractAdapter =
  Object.freeze({
    contractId: "supervisor",
    decisionModelStep: SUPERVISOR_DECISION_MODEL_STEP,
    responseModelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
    projectCallIdentity: projectSupervisorCallIdentity,
    projectResume: projectSupervisorResumeContext,
    async decide(request, options) {
      return runSupervisorDecision(request, {
        call: options.call,
        toolResults: options.toolResults,
        includeAcknowledgement: options.includeAcknowledgement,
        includeTitle: options.includeTitle,
        allowedRoleIds: options.allowedRoleIds,
        availableWorkerCapabilityCatalog:
          options.availableWorkerCapabilityCatalog,
        ...(options.resume ? { resume: options.resume } : {}),
      });
    },
    async authorResponse(request, options) {
      return runSupervisorResponse(request, {
        call: options.call,
        toolResults: options.toolResults,
        ...(options.resume ? { resume: options.resume } : {}),
      });
    },
  });

/** Executes the Supervisor root contract for an already composed request. */
export async function runSupervisorRootExecution(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
}): Promise<RequestRunnerResult> {
  return runRootExecutionKernel({
    request: params.request,
    ledger: params.ledger,
  });
}
