import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestExecutionSeed } from "../request/contracts.js";

export const SCHEDULED_EXECUTION_CONTEXT_KIND =
  "runtime_scheduled_execution_v1" as const;

type ScheduledExecutionPhase = "decision" | "response";

const SCHEDULED_EXECUTION_CONTEXT_POLICY = [
  "runtime_scheduled_execution_v1 is trusted request-local state from the runtime scheduler, bound to this request and Job run. The current user message contains the saved task to execute now.",
  "This Job run has already been triggered; do not reinterpret its saved task as a new request to create or configure this schedule.",
  "Preserve who performs the requested action: a reminder asks you to notify the user; a task delegated to you asks you to perform the assigned work. Execution origin does not change the saved task or its actor.",
  "This state does not add user intent, grant additional authorization, or establish completion. It is not a user fact or a memory candidate.",
].join("\n");

const SCHEDULED_EXECUTION_PHASE_POLICY: Readonly<
  Record<ScheduledExecutionPhase, string>
> = Object.freeze({
  decision:
    "Choose the action needed for this current run under the saved task and existing authority; the origin does not select a capability or require an external action for a reminder notification.",
  response:
    "Present the requested outcome of this current run, preserving the task's actor. Do not claim you were asked to perform an action that the saved task asks the user to perform.",
});

export function projectScheduledExecutionContext(
  request: Pick<RequestExecutionSeed, "requestId" | "scheduledExecution">,
  instructions: string,
  phase: ScheduledExecutionPhase,
): Readonly<{
  instructions: string;
  referenceMessages: readonly ChatMessage[];
}> {
  const reference = request.scheduledExecution;
  if (!hasScheduledExecutionOrigin(reference)) {
    return Object.freeze({
      instructions,
      referenceMessages: Object.freeze([]),
    });
  }
  const capsule = Object.freeze({
    kind: SCHEDULED_EXECUTION_CONTEXT_KIND,
    authority: "runtime_scheduler",
    purpose: "execute_saved_task_for_current_run",
    requestId: request.requestId,
    jobId: reference.jobId,
    runId: reference.runId,
    scheduledAt: reference.scheduledAt,
    triggerType: reference.triggerType,
    presenceEffect:
      "execution_origin_only_not_new_intent_authorization_or_completion",
  });
  return Object.freeze({
    instructions: [
      instructions,
      SCHEDULED_EXECUTION_CONTEXT_POLICY,
      SCHEDULED_EXECUTION_PHASE_POLICY[phase],
    ].join("\n\n"),
    referenceMessages: Object.freeze([
      Object.freeze({
        role: "system" as const,
        content: JSON.stringify(capsule),
      }),
    ]),
  });
}

function hasScheduledExecutionOrigin(
  reference: RequestExecutionSeed["scheduledExecution"],
): reference is NonNullable<RequestExecutionSeed["scheduledExecution"]> {
  return reference !== undefined;
}

export function isScheduledExecutionContextMessage(
  message: ChatMessage,
): boolean {
  if (message.role !== "system") return false;
  return message.content.startsWith(
    `{"kind":${JSON.stringify(SCHEDULED_EXECUTION_CONTEXT_KIND)},`,
  );
}
