import type { SessionRecord } from "../types.js";
import { assertValidSessionId } from "../record/rules.js";
import { saveDurableSessionFile } from "../durable-session-commit.js";
import {
  collectSessionContinuationBlobs,
  cleanupConsumedSessionContinuations,
} from "./continuation-cleanup.js";
import {
  assertContinuationSchema,
  createSessionContinuationBlobs,
} from "./continuation-blobs.js";
import { projectSessionRequestLifecycle } from "./projection.js";
import {
  startSessionActivation,
  commitSessionApprovalWait,
} from "./activation-transitions.js";
import { commitSessionApprovalDecision } from "./approval-decisions.js";
import {
  cancelSessionApprovalWait,
  commitSessionTerminal,
  interruptSessionActivation,
} from "./terminal-transitions.js";
import {
  acceptedLifecycle,
  appendLifecycleEvent,
  lifecycleRequest,
  rejectLifecycleCommand,
  touchLifecycle,
  validateActivationExpectation,
  validateWaitExpectation,
  type LifecycleMutationContext,
} from "./record-operations.js";
import type {
  SessionLifecycleMutationResult,
  SessionRequestLifecycleStore,
} from "./contracts.js";

export type SessionLifecycleServiceDependencies = Readonly<{
  sessionsDir: string;
  now(): Date;
  createMessageId(session: SessionRecord): string;
  enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  read(sessionId: string): Promise<SessionRecord | null>;
  list(): Promise<SessionRecord[]>;
}>;

/** Commands share SessionService's queue and file, never a parallel checkpoint store. */
export function createSessionRequestLifecycle(
  dependencies: SessionLifecycleServiceDependencies,
): SessionRequestLifecycleStore {
  const blobs = createSessionContinuationBlobs(dependencies.sessionsDir);

  async function mutate(
    sessionId: string,
    operation: (
      context: LifecycleMutationContext,
    ) =>
      | SessionLifecycleMutationResult
      | Promise<SessionLifecycleMutationResult>,
  ): Promise<SessionLifecycleMutationResult> {
    assertValidSessionId(sessionId);
    return dependencies.enqueue(sessionId, async () => {
      const session = await dependencies.read(sessionId);
      if (!session) return rejectLifecycleCommand("session_missing");
      const previousBlobs = collectSessionContinuationBlobs(session);
      const result = await operation({
        session,
        timestamp: dependencies.now().toISOString(),
        createMessageId: dependencies.createMessageId,
      });
      if (!result.accepted || result.duplicate) return result;
      await saveDurableSessionFile(dependencies.sessionsDir, session);
      await cleanupConsumedSessionContinuations(
        dependencies.sessionsDir,
        session,
        previousBlobs,
      );
      return result;
    });
  }

  async function readRequest(sessionId: string, requestId: string) {
    const session = await dependencies.read(sessionId);
    return session?.requests?.find(
      (request) => request.requestId === requestId,
    );
  }

  return {
    ...blobs,
    startActivation: (sessionId, command) =>
      mutate(sessionId, (context) => startSessionActivation(context, command)),
    commitWait: (sessionId, command) =>
      mutate(sessionId, async (context) => {
        // Verify immutable content before acknowledging its canonical reference.
        // The versioned continuation remains opaque to lifecycle storage.
        assertContinuationSchema(command.continuation);
        await blobs.readBlob(sessionId, command.continuation.blob);
        return commitSessionApprovalWait(context, command);
      }),
    commitDecision: (sessionId, command) =>
      mutate(sessionId, (context) =>
        commitSessionApprovalDecision(context, command),
      ),
    cancelWait: (sessionId, command) =>
      mutate(sessionId, (context) =>
        cancelSessionApprovalWait(context, command),
      ),
    commitTerminal: (sessionId, command) =>
      mutate(sessionId, (context) => commitSessionTerminal(context, command)),
    interruptActivation: (sessionId, command) =>
      mutate(sessionId, (context) =>
        interruptSessionActivation(context, command),
      ),
    appendActivationEvent: (sessionId, command) =>
      mutate(sessionId, (context) => {
        const request = lifecycleRequest(
          context.session,
          command.expected.requestId,
        );
        const mismatch = validateActivationExpectation(
          request,
          command.expected,
        );
        if (mismatch) return rejectLifecycleCommand(mismatch, request);
        if (
          command.payload.type === "completed" ||
          command.payload.type === "failed"
        )
          return rejectLifecycleCommand("invalid_command", request);
        touchLifecycle(context, request!);
        return acceptedLifecycle(request!, [
          appendLifecycleEvent(context, request!, command.payload),
        ]);
      }),
    async get(sessionId, requestId) {
      const request = await readRequest(sessionId, requestId);
      return request ? (projectSessionRequestLifecycle(request) ?? null) : null;
    },
    async listWaiting(sessionId) {
      const sessions = sessionId
        ? [await dependencies.read(sessionId)]
        : await dependencies.list();
      return sessions.flatMap((session) =>
        (session?.requests ?? []).flatMap((request) => {
          if (request.status !== "awaiting_approval") return [];
          const projected = projectSessionRequestLifecycle(request);
          return projected ? [projected] : [];
        }),
      );
    },
    async getDecisionReceipt(sessionId, requestId, generation, commandId) {
      const request = await readRequest(sessionId, requestId);
      if (request?.generation !== generation) return null;
      const receipt = request.lifecycle?.decisionReceipts.find(
        (value) => value.commandId === commandId,
      );
      return receipt ? structuredClone(receipt) : null;
    },
    async getContinuation(sessionId, expected) {
      const session = await dependencies.read(sessionId);
      if (!session) return null;
      const request = lifecycleRequest(session, expected.requestId);
      if (validateWaitExpectation(request, expected)) return null;
      return structuredClone(request!.lifecycle.wait!.continuation);
    },
  };
}
