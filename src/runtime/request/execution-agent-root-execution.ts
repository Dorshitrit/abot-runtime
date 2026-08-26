import {
  projectSupervisorCallIdentity,
  projectSupervisorResumeContext,
} from "../steps/supervisor-decision/index.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
  runExecutionAgentDecision,
  runExecutionAgentResponse,
} from "../steps/execution-agent/index.js";
import { encodeExecutionAgentAuditObjective } from "../steps/auditor-decision/index.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";
import type {
  RequestRootContractAdapter,
  RootContractDecision,
} from "./root-execution-kernel.js";

export const EXECUTION_AGENT_ROOT_CONTRACT: RequestRootContractAdapter =
  Object.freeze({
    contractId: "execution_agent",
    decisionModelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    responseModelStep: EXECUTION_AGENT_RESPONSE_MODEL_STEP,
    deferRespondPresentation: true,
    projectCallIdentity: projectSupervisorCallIdentity,
    projectResume: projectSupervisorResumeContext,
    async decide(request, options) {
      const requestSteering = resolveRequestSteeringInbox(
        request.requestSteering,
      );
      const outcome = await runExecutionAgentDecision(request, {
        head: options.head,
        call: options.callFrame,
        steeringSnapshot: requestSteering.snapshot(),
        includeAcknowledgement: options.includeAcknowledgement,
        includeTitle: options.includeTitle,
        allowPlanner: options.allowedRoleIds.includes("planner"),
        allowAuditor: options.allowedRoleIds.includes("reviewer"),
      });
      return Object.freeze({
        decision: projectKernelDecision(
          outcome.decision,
          outcome.steeringVersion,
        ),
        steeringVersion: outcome.steeringVersion,
      });
    },
    async authorResponse(request, options) {
      const requestSteering = resolveRequestSteeringInbox(
        request.requestSteering,
      );
      return runExecutionAgentResponse(request, {
        head: options.head,
        call: options.callFrame,
        steeringSnapshot: requestSteering.snapshot(),
      });
    },
  });

function projectKernelDecision(
  decision: Awaited<ReturnType<typeof runExecutionAgentDecision>>["decision"],
  steeringVersion: number,
): RootContractDecision {
  const presentation = {
    ...(decision.acknowledgement !== undefined
      ? { acknowledgement: decision.acknowledgement }
      : {}),
    ...(decision.title !== undefined ? { title: decision.title } : {}),
  };
  switch (decision.action) {
    case "reconsider_capability_selection":
      return Object.freeze({
        action: "reconsider_capability_selection" as const,
        selection: decision.selection,
      });
    case "open_capability_scope":
      return Object.freeze({
        action: "update_capability_scope" as const,
        mode: "open" as const,
        catalogGroupIds: decision.catalogGroupIds,
        ...presentation,
      });
    case "extend_capability_scope":
      return Object.freeze({
        action: "update_capability_scope" as const,
        mode: "extend" as const,
        catalogGroupIds: decision.catalogGroupIds,
        ...presentation,
      });
    case "invoke_capability":
      if (!decision.controls) {
        throw new Error("execution_agent_capability_controls_missing");
      }
      return Object.freeze({
        action: "invoke_capability" as const,
        capabilityId: decision.capabilityId,
        intent: decision.intent,
        controls: decision.controls,
        ...(decision.workingDirectory !== undefined
          ? { workingDirectory: decision.workingDirectory }
          : {}),
        ...presentation,
      });
    case "invoke_capabilities":
      if (decision.invocations.some((invocation) => !invocation.controls)) {
        throw new Error("execution_agent_capability_controls_missing");
      }
      return Object.freeze({
        action: "invoke_capabilities" as const,
        invocations: Object.freeze(
          decision.invocations.map((invocation) =>
            Object.freeze({
              capabilityId: invocation.capabilityId,
              intent: invocation.intent,
              controls: invocation.controls!,
            }),
          ),
        ),
        ...(decision.workingDirectory !== undefined
          ? { workingDirectory: decision.workingDirectory }
          : {}),
        ...presentation,
      });
    case "respond":
      return Object.freeze({ action: "respond" as const, ...presentation });
    case "blocked":
      return Object.freeze({
        action: "blocked" as const,
        response: decision.response,
        ...presentation,
      });
    case "invoke_planner":
      return Object.freeze({
        action: "invoke_role" as const,
        roleId: "planner" as const,
        objective: decision.objective,
        ...presentation,
      });
    case "invoke_auditor":
      return Object.freeze({
        action: "invoke_role" as const,
        roleId: "reviewer" as const,
        objective: encodeExecutionAgentAuditObjective(
          decision.criterionIds,
          steeringVersion,
        ),
        ...presentation,
      });
  }
}
