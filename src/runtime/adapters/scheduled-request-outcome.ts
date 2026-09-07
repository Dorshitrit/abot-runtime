import type { SessionMessage } from "../../sessions/types.js";
import type { SessionStore } from "../ports.js";
import type {
  SchedulerRun,
  SchedulerRunOutcome,
} from "../scheduler/contracts.js";

export type ScheduledRequestEvent = Record<string, unknown>;
export type ScheduledRequestSettlement = Readonly<{
  outcome: SchedulerRunOutcome;
  event: ScheduledRequestEvent;
}>;

export function isScheduledTerminalEvent(
  event: ScheduledRequestEvent,
): boolean {
  return event.type === "completed" || event.type === "failed";
}

export function failedScheduledRequestOutcome(
  error: unknown,
): ScheduledRequestSettlement {
  const message = error instanceof Error ? error.message : String(error);
  return {
    outcome: { status: "failed", error: message },
    event: { type: "failed", error: message },
  };
}

/** A captured completion is provisional until canonical assistant persistence is proven. */
export async function resolveScheduledRequestOutcome(
  terminal: ScheduledRequestEvent | undefined,
  sessions: SessionStore,
  run: SchedulerRun,
): Promise<ScheduledRequestSettlement> {
  if (!terminal)
    return failedScheduledRequestOutcome("scheduled_request_missing_terminal");
  if (terminal.type === "failed") {
    const failure = failedScheduledRequestOutcome(
      terminal.error ?? "scheduled_request_failed",
    );
    return { ...failure, event: { ...terminal, ...failure.event } };
  }
  try {
    const session = await sessions.getSessionById(run.sessionId);
    const result = session?.messages.find((message) =>
      isScheduledAssistantReply(message, run.requestId),
    );
    if (!result)
      return failedScheduledRequestOutcome("scheduled_result_not_persisted");
    return {
      outcome: {
        status: "succeeded",
        resultText: String(terminal.output ?? ""),
        resultMessageId: result.id,
      },
      event: terminal,
    };
  } catch (error) {
    return failedScheduledRequestOutcome(error);
  }
}

function isScheduledAssistantReply(
  message: SessionMessage,
  requestId: string,
): boolean {
  if (message.role !== "assistant") return false;
  return message.requestId === requestId;
}
