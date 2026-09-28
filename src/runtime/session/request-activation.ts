import { randomUUID } from "node:crypto";
import { SessionCommitOutcomeUnknownError } from "../../sessions/durable-session-commit.js";
import type {
  SessionRequestLifecycleSnapshot,
  SessionRequestLifecycleStore,
  SessionStartActivationCommand,
} from "../../sessions/request-lifecycle/contracts.js";

/** A failed acknowledgement cannot leave this owner's initial activation live. */
export async function startRequestActivation(
  store: SessionRequestLifecycleStore,
  sessionId: string,
  command: SessionStartActivationCommand,
): Promise<SessionRequestLifecycleSnapshot> {
  try {
    const started = await store.startActivation(sessionId, command);
    if (!started.accepted)
      throw new Error(`request_activation_rejected:${started.reason}`);
    return started.current;
  } catch (error) {
    if (!(error instanceof SessionCommitOutcomeUnknownError)) throw error;
    const current = await store.get(sessionId, command.requestId);
    if (!isUnconfirmedInitialActivation(current, command)) throw error;
    // No runner has started. Close the exact visible activation before its
    // owner releases the control; an uncertain commit never permits dispatch.
    const interrupted = await store.interruptActivation(sessionId, {
      expected: {
        requestId: current.requestId,
        generation: current.generation,
        revision: current.revision,
        activationId: command.activationId,
        ownerEpoch: command.ownerEpoch,
      },
      commandId: randomUUID(),
      message: {
        content:
          "The task was interrupted because its startup could not be saved reliably.",
      },
    });
    if (!interrupted.accepted)
      throw new Error(
        `request_activation_interruption_rejected:${interrupted.reason}`,
        { cause: error },
      );
    throw error;
  }
}

function isUnconfirmedInitialActivation(
  current: SessionRequestLifecycleSnapshot | null,
  command: SessionStartActivationCommand,
): current is SessionRequestLifecycleSnapshot {
  if (current?.status !== "streaming") return false;
  if (current.activation?.activationId !== command.activationId) return false;
  return current.activation.ownerEpoch === command.ownerEpoch;
}
