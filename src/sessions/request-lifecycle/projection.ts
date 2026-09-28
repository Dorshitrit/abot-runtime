import type { SessionRequestRecord } from "../types.js";
import type { SessionRequestLifecycleSnapshot } from "./contracts.js";

/** Lifecycle metadata is decoded independently of the versioned continuation bytes. */
export function projectSessionRequestLifecycle(
  request: SessionRequestRecord,
): SessionRequestLifecycleSnapshot | undefined {
  const lifecycle = request.lifecycle;
  if (!lifecycle || lifecycle.schemaVersion !== 1 || !request.generation)
    return undefined;
  const wait = lifecycle.wait;
  return structuredClone({
    schemaVersion: 1,
    sessionId: request.sessionId,
    requestId: request.requestId,
    generation: request.generation,
    status: request.status,
    revision: lifecycle.revision,
    activation: lifecycle.activation,
    ...(request.status === "awaiting_approval" && wait
      ? {
          wait: {
            waitId: wait.waitId,
            createdAt: wait.createdAt,
            presentationMessageId: wait.presentationMessageId,
            approvals: wait.approvals,
          },
        }
      : {}),
    decisionReceipts: lifecycle.decisionReceipts,
    ...(lifecycle.terminalCause
      ? { terminalCause: lifecycle.terminalCause }
      : {}),
  });
}
