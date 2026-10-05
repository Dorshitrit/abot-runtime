import {
  failureResult,
  type ToolExecutionContext,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";
import type { ExecProcessSnapshot } from "./types.js";

/** Output remains pending; neither an exit nor a size rejection is an acknowledgement. */
export function retainedOutputFailure(
  snapshot: ExecProcessSnapshot,
  context?: ToolExecutionContext,
): ToolImplementationOutput {
  const expired = hasUnavailableOutput(snapshot);
  return failureResult(
    {
      errorCode: expired
        ? "exec_output_expired"
        : snapshot.outputFailure
          ? "exec_output_storage_failed"
          : "exec_output_delivery_pending",
      message: expired
        ? "The retained output expired or is no longer available. The command was already started; it has not been run again."
        : snapshot.outputFailure
          ? "Output storage or delivery failed. The command was already started; do not run it again. Any committed bytes are retained for the configured retention period; complete output delivery is not confirmed."
          : "The output exceeds the delivery envelope and remains retained. The command was already executed; do not run it again.",
      data: {
        processId: snapshot.processId,
        processStatus: snapshot.status,
        nextCursor: snapshot.nextCursor,
        ...(snapshot.exitCode !== undefined
          ? { exitCode: snapshot.exitCode }
          : {}),
        ...(snapshot.terminationReason
          ? { terminationReason: snapshot.terminationReason }
          : {}),
        outputDelivery: expired ? "expired" : "pending",
        ...(snapshot.outputFailure
          ? { outputStorageFailure: snapshot.outputFailure }
          : {}),
        retainedCharacters:
          snapshot.stdout.text.length + snapshot.stderr.text.length,
      },
    },
    context?.resultBudget,
  );
}

function hasUnavailableOutput(snapshot: ExecProcessSnapshot): boolean {
  if (snapshot.outputFailure?.code === "exec_output_expired") return true;
  return snapshot.outputFailure?.code === "exec_output_expired_or_unavailable";
}
