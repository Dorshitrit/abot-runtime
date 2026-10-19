import { canRootReadSkills } from "./root-skill-read.js";
import { isSupervisorSkillWriteCapabilityId } from "../orchestration/worker-capabilities/supervisor-skill-authority.js";
import { isSupervisorSkillWriteSelection } from "../steps/supervisor-skill-authoring/contract.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";
import type { RoleCallLedger, RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import {
  projectSupervisorCallIdentity,
  projectSupervisorResumeContext,
  runSupervisorDecision,
  SUPERVISOR_DECISION_MODEL_STEP,
} from "../steps/supervisor-decision/index.js";
import {
  runSupervisorAuthoredResponse,
  SUPERVISOR_RESPONSE_MODEL_STEP,
} from "../steps/supervisor-response/index.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import type { RequestRunnerResult } from "./result.js";
import {
  runRootExecutionKernel,
  type RequestRootContractAdapter,
} from "./root-execution-kernel.js";
import { projectRequestSteeringSnapshot } from "./request-steering.js";

export const SUPERVISOR_ROOT_CONTRACT: RequestRootContractAdapter =
  Object.freeze({
    contractId: "supervisor",
    decisionModelStep: SUPERVISOR_DECISION_MODEL_STEP,
    responseModelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
    projectCallIdentity: projectSupervisorCallIdentity,
    projectResume: projectSupervisorResumeContext,
    async decide(request, options) {
      if (hasSettledSupervisorSkillWrite(options.head)) return {
        decision: { action: "respond" as const },
        steeringVersion: resolveRequestSteeringInbox(request.requestSteering).snapshot().version,
      };
      const outcome = await runSupervisorDecision(request, {
        call: options.call,
        skillReadHead: options.head,
        memoryRecallCount: options.head.state.memoryRecalls.length,
        allowSkillReads: canRootReadSkills(request, options.head, options.callFrame),
        remainingRoleCalls: options.head.policy.limits.maxCalls -
          options.head.state.calls.length,
        remainingCapabilityExecutions: options.head.policy.limits.maxCapabilityExecutions -
          options.head.state.capabilityExecutions.length,
        toolResults: options.toolResults,
        includeAcknowledgement: options.includeAcknowledgement,
        includeTitle: options.includeTitle,
        allowedRoleIds: options.allowedRoleIds,
        availableWorkerCapabilityCatalog: options.availableWorkerCapabilityCatalog,
        availableSkillWriteOperationIds: options.availableSkillWriteOperationIds,
        ...(options.head.state.initialMemory?.message
          ? { initialMemoryMessage: options.head.state.initialMemory.message }
          : {}),
        ...(options.memoryRecallMessage
          ? { memoryRecallMessage: options.memoryRecallMessage }
          : {}),
        ...(options.resume ? { resume: options.resume } : {}),
      });
      const { decision, steeringVersion } = outcome;
      if (decision.action === "no_save") return {
        steeringVersion, decision: {
          action: "respond", responseRecommendation: decision.reason,
          responseRecommendationOrigin: "skill_authoring_no_save",
          ...(decision.acknowledgement ? { acknowledgement: decision.acknowledgement } : {}),
          ...(decision.title ? { title: decision.title } : {}),
        },
      };
      if (!isSupervisorSkillWriteSelection(decision)) return { decision, steeringVersion };
      return {
        steeringVersion, decision: {
          action: "prepare_skill_write", selection: decision,
          ...(decision.acknowledgement ? { acknowledgement: decision.acknowledgement } : {}),
          ...(decision.title ? { title: decision.title } : {}),
        },
      };
    },
    async authorResponse(request, options) {
      return runSupervisorAuthoredResponse(request, {
        responseRecommendation: options.responseRecommendation,
        responseRecommendationOrigin: options.responseRecommendationOrigin,
        call: options.call,
        skillReadHead: options.head,
        toolResults: options.toolResults,
        ...(options.head.state.initialMemory?.message
          ? { initialMemoryMessage: options.head.state.initialMemory.message }
          : {}),
        ...(options.memoryRecallMessage
          ? { memoryRecallMessage: options.memoryRecallMessage }
          : {}),
        steeringSnapshot: projectRequestSteeringSnapshot(
          request.requestSteering,
          options.steeringVersion,
        ),
        ...(options.resume ? { resume: options.resume } : {}),
      });
    },
  });

/** A settled write is terminal even after approval restoration; pending writes stay pending. */
function hasSettledSupervisorSkillWrite(head: RoleCallLedgerHead): boolean {
  return head.state.capabilityExecutions.some((execution) => {
    if (execution.callId !== head.state.rootCallId) return false;
    if (execution.status !== "settled") return false;
    return isSupervisorSkillWriteCapabilityId(execution.capabilityId);
  });
}

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
