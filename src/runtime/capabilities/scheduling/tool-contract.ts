import type {
  ToolNormalInvocationContract,
  ToolNormalInvocationOperation,
  ToolNormalInvocationPropertyInput,
} from "../../../capabilities/tool-types.js";
import { scheduleCreateOperations } from "./create-operations.js";
import { scheduleUpdateOperations } from "./update-operations.js";
import { scheduleTextField as text } from "./tool-input-properties.js";
const identity = { jobId: text(200) };

function operation(
  operationId: string,
  summary: string,
  properties: Record<string, ToolNormalInvocationPropertyInput>,
  required: string[],
  effect: "read_only" | "mutating",
): ToolNormalInvocationOperation {
  return {
    operationId,
    summary,
    effect,
    approval: "request_policy",
    fixedParams: { action: operationId },
    input: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  };
}

export const schedulingToolContract: ToolNormalInvocationContract = {
  version: 1,
  operations: [
    ...scheduleCreateOperations,
    operation(
      "list",
      "List this conversation's schedules newest first, without executing them or exposing their task prompts. Each page has up to 100 Jobs; pass its nextCursor to retrieve the next page until null. A stale cursor requires a fresh list without cursor.",
      {
        cursor: text(200),
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      [],
      "read_only",
    ),
    operation(
      "get",
      "Read this conversation's Job and recent run history by exact Job ID.",
      identity,
      ["jobId"],
      "read_only",
    ),
    ...scheduleUpdateOperations,
    operation(
      "pause",
      "Pause future starts of this Job, including its pending occurrence. An already-started run continues.",
      identity,
      ["jobId"],
      "mutating",
    ),
    operation(
      "resume",
      "Resume this paused Job from its next future occurrence, without backfill.",
      identity,
      ["jobId"],
      "mutating",
    ),
    operation(
      "cancel",
      "Cancel this Job and its pending occurrence. An already-started run continues.",
      identity,
      ["jobId"],
      "mutating",
    ),
    operation(
      "run_now",
      "Request one immediate run of this Job; wait if this conversation is busy. Does not change its ordinary recurrence.",
      identity,
      ["jobId"],
      "mutating",
    ),
  ],
};
