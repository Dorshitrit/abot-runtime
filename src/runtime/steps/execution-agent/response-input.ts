import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { projectRootSessionMemory } from "../../context/session-memory/root-projection.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import { EXECUTION_AGENT_RESPONSE_MODEL_STEP } from "./contracts.js";
import { buildExecutionAgentResponseInstructions } from "./response-prompt.js";
import {
  buildExecutionContinuationMessages,
  buildExecutionStateMessage,
} from "./state-context.js";

export const EXECUTION_RESPONSE_ASSIGNMENT_MESSAGE_KIND =
  "runtime_execution_response_assignment_v1" as const;

export function buildExecutionAgentResponseInput(
  request: RequestExecutionSeed,
  options: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    steeringSnapshot: RequestSteeringSnapshot;
  }>,
): Readonly<{
  context: RequestContextProjection;
  messages: ChatMessage[];
  modelStep: typeof EXECUTION_AGENT_RESPONSE_MODEL_STEP;
}> {
  if (
    options.head.state.requestId !== request.requestId ||
    options.head.state.phase !== "running" ||
    options.head.state.rootCallId !== options.call.callId ||
    options.head.state.activeCallId !== options.call.callId ||
    options.call.status !== "active"
  ) {
    throw new Error("execution_agent_response_head_invalid");
  }
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: EXECUTION_AGENT_RESPONSE_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const continuationMessages = buildExecutionContinuationMessages(
    options.head,
    options.call,
  );
  const sessionMemory = projectRootSessionMemory(request);
  const context = projectRequestContext({
    instructions: buildExecutionAgentResponseInstructions(),
    ...sessionMemory,
    prompt: request.prompt,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    referenceMessages: [
      buildExecutionResponseAssignmentMessage(
        options.head,
        options.call,
        options.steeringSnapshot,
      ),
      buildExecutionStateMessage(options.head, options.call),
    ],
    ...(continuationMessages.length > 0 ? { continuationMessages } : {}),
    deferCompactionFailure: true,
    budget,
    diagnostic: {
      requestId: request.requestId,
      modelStep: EXECUTION_AGENT_RESPONSE_MODEL_STEP,
      callId: options.call.callId,
    },
    onEvent: request.onEvent,
  });
  return Object.freeze({
    context,
    messages: appendRequestSteeringContext(
      context.messages,
      options.steeringSnapshot,
    ),
    modelStep: EXECUTION_AGENT_RESPONSE_MODEL_STEP,
  });
}

function buildExecutionResponseAssignmentMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  steeringSnapshot: RequestSteeringSnapshot,
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: EXECUTION_RESPONSE_ASSIGNMENT_MESSAGE_KIND,
      authority: "runtime_assignment",
      purpose: "present_accepted_respond_decision",
      requestId: head.state.requestId,
      stateRevision: head.revision,
      callId: call.callId,
      activationCount: call.activationCount,
      steeringVersion: steeringSnapshot.version,
      completionKind: "respond",
      outputContract: "raw_user_facing_text_only",
      presenceEffect:
        "presentation_scope_only_not_user_intent_or_action_authority",
    }),
  });
}
