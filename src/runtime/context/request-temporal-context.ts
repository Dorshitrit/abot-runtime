import type { ChatMessage } from "../../model-gateway/types.js";

export const REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND =
  "runtime_request_time_v1" as const;

export type RequestTemporalContext = Readonly<{
  currentDateTime: string;
  timeZone: string;
}>;

export type RequestTemporalContextCapsule = Readonly<{
  kind: typeof REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND;
  currentDateTime: string;
  timeZone: string;
  passive: "relative_time_reference_not_user_intent";
}>;

/** Captures one server-local clock observation for the complete request. */
export function captureRequestTemporalContext(
  options: Readonly<{ instant?: Date; timeZone?: string }> = {},
): RequestTemporalContext {
  const instant = new Date(options.instant?.getTime() ?? Date.now());
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("request_temporal_context_instant_invalid");
  }
  const timeZone =
    options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (
    typeof timeZone !== "string" ||
    timeZone.trim() !== timeZone ||
    !timeZone
  ) {
    throw new Error("request_temporal_context_timezone_invalid");
  }

  try {
    const currentDateTime = new Intl.DateTimeFormat(
      "sv-SE-u-ca-gregory-nu-latn",
      {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      },
    ).format(instant);
    return Object.freeze({ currentDateTime, timeZone });
  } catch {
    throw new Error("request_temporal_context_timezone_invalid");
  }
}

export function buildRequestTemporalContextMessage(
  context: RequestTemporalContext,
): ChatMessage {
  const capsule: RequestTemporalContextCapsule = Object.freeze({
    kind: REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND,
    currentDateTime: context.currentDateTime,
    timeZone: context.timeZone,
    passive: "relative_time_reference_not_user_intent",
  });
  return Object.freeze({
    role: "system" as const,
    content: JSON.stringify(capsule),
  });
}
