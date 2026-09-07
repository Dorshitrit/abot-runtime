import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { assertValidSessionId } from "../../sessions/record/rules.js";
import type { SessionStore } from "../ports.js";
import { createSessionDeletionBoundary } from "./session-deletion-boundary.js";
import { createSessionMutationQueue } from "./session-mutation-queue.js";

type DeletionStore = Pick<SessionStore, "deleteSessionWithStats">;
type DeleteSession = DeletionStore["deleteSessionWithStats"];

// Adapter composition metadata. Each bound operation owns its deletion lifetime.
const bindings = new WeakMap<
  DeletionStore,
  WeakMap<RuntimeAttachmentStore, DeleteSession>
>();

function attachmentBindings(sessions: DeletionStore) {
  const existing = bindings.get(sessions);
  if (existing) return existing;
  const bound = new WeakMap<RuntimeAttachmentStore, DeleteSession>();
  bindings.set(sessions, bound);
  return bound;
}

/** The composed owner already finalizes attachments within its session transaction. */
export function bindManagedSessionAttachmentDeletion(
  sessions: DeletionStore,
  attachments: RuntimeAttachmentStore,
): void {
  attachmentBindings(sessions).set(attachments, (id) =>
    sessions.deleteSessionWithStats(id),
  );
}

export async function deleteSessionWithAttachments(
  sessions: DeletionStore,
  attachments: RuntimeAttachmentStore | undefined,
  sessionId: string,
) {
  assertValidSessionId(sessionId);
  if (!attachments) return sessions.deleteSessionWithStats(sessionId);
  const bound = attachmentBindings(sessions);
  const existing = bound.get(attachments);
  if (existing) return existing(sessionId);
  const remove = createCompatibilitySessionDeletion(sessions, attachments);
  bound.set(attachments, remove);
  return remove(sessionId);
}

function createCompatibilitySessionDeletion(
  sessions: DeletionStore,
  attachments: RuntimeAttachmentStore,
): DeleteSession {
  const enqueue = createSessionMutationQueue();
  const pending = new Map<
    string,
    {
      deletion: ReturnType<typeof createSessionDeletionBoundary>;
      attempt: ReturnType<DeleteSession> | undefined;
      callers: number;
      delivered: boolean;
    }
  >();

  return async (sessionId) => {
    let current = pending.get(sessionId);
    if (!current) {
      current = {
        deletion: createSessionDeletionBoundary(sessions, enqueue, (result) =>
          deleteSessionAttachmentsIfSupported(attachments, result.sessionId),
        ),
        attempt: undefined,
        callers: 0,
        delivered: false,
      };
      pending.set(sessionId, current);
    }
    current.callers += 1;
    try {
      current.attempt ??= current.deletion.deleteSessionWithStats(sessionId);
      const result = await current.attempt;
      if (current.delivered) {
        return {
          sessionId,
          deleted: false,
          deletedMessages: 0,
          deletedRequests: 0,
        };
      }
      current.delivered = true;
      return result;
    } finally {
      current.callers -= 1;
      // Concurrent callers share failure; only a later explicit call may retry.
      if (current.callers === 0) current.attempt = undefined;
      // Raw stores may reuse IDs after successful deletion; retain only failed work.
      if (canReleaseCompatibilityDeletion(current)) pending.delete(sessionId);
    }
  };
}

function canReleaseCompatibilityDeletion(state: {
  callers: number;
  delivered: boolean;
}): boolean {
  return state.callers === 0 && state.delivered;
}

export async function deleteSessionAttachmentsIfSupported(
  attachments: RuntimeAttachmentStore | undefined,
  sessionId: string,
): Promise<void> {
  if (!attachments) return;
  try {
    await attachments.deleteSessionAttachments(sessionId);
  } catch (error) {
    if (isUnsupportedAttachmentOwner(error)) return;
    throw error;
  }
}

function isUnsupportedAttachmentOwner(error: unknown): boolean {
  return error instanceof Error && error.message === "attachment_owner_invalid";
}
