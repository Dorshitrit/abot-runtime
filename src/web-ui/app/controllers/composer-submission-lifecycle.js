function scopeKey(scope) {
  return JSON.stringify([scope.environmentId, scope.sessionId]);
}

/** Explicit refusal is distinct from a missing acknowledgement after an effect. */
export class ComposerSubmissionRefused extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ComposerSubmissionRefused";
  }
}

export function isDefiniteSubmissionRefusal(error) {
  return error instanceof ComposerSubmissionRefused;
}

/** Owns captured payloads from take() until acceptance, restoration or manual review. */
export function createComposerSubmissionLifecycle({ drafts, onChange = () => {} }) {
  const attempts = new Map();
  let sequence = 0;

  function hasPendingScope(scope) {
    const key = scopeKey(scope);
    return [...attempts.values()].some((attempt) =>
      scopeKey(attempt.payload.scope) === key && ["preparing", "sending"].includes(attempt.phase));
  }

  function publish(attempt, phase) {
    attempt.phase = phase;
    onChange(attempt);
  }

  async function submitCaptured({ payload, action, settings, prepare = async () => {}, execute, accepted = async () => {}, prepareRestore = async (attempt) => attempt.payload }) {
    const attempt = { id: ++sequence, action, settings, payload, phase: "preparing", error: null };
    attempts.set(attempt.id, attempt);
    publish(attempt, "preparing");
    let result;
    try {
      await prepare(attempt);
      publish(attempt, "sending");
      result = await execute(attempt);
    } catch (error) {
      attempt.error = error;
      if (canRestoreRejectedSubmission(attempt, error)) {
        try {
          const restored = await prepareRestore(attempt);
          drafts.restore(restored);
          attempts.delete(attempt.id);
          publish(attempt, "refused");
          return { status: "refused", attempt, error };
        } catch (restoreError) { attempt.error = restoreError; }
      }
      publish(attempt, "uncertain");
      return { status: "uncertain", attempt, error };
    }
    attempt.result = result;
    attempts.delete(attempt.id);
    publish(attempt, "accepted");
    // Acceptance cannot turn into a rejected send because post-send bookkeeping fails.
    try { await accepted(attempt, result); }
    catch (error) { return { status: "accepted", attempt, result, bookkeepingError: error }; }
    return { status: "accepted", attempt, result };
  }

  async function restoreForManualReview(id, authorize) {
    const attempt = attempts.get(id);
    if (!attempt || attempt.phase !== "uncertain") return false;
    const approval = await authorize(attempt);
    if (approval !== true && !approval?.release) return false;
    if (attempts.get(id) !== attempt || attempt.phase !== "uncertain") return false;
    drafts.restore(approval?.release ? { ...attempt.payload, release: approval.release } : attempt.payload);
    attempts.delete(id);
    publish(attempt, "restored");
    return true;
  }

  return {
    submit(options) {
      if (hasPendingScope(options.draft.scope))
        return Promise.reject(new ComposerSubmissionRefused("A message is already being submitted for this conversation."));
      return submitCaptured({ ...options, payload: options.draft.take() });
    },
    submitCaptured,
    hasPendingScope,
    restoreForManualReview,
    paused: (scope) => [...attempts.values()].filter((attempt) =>
      attempt.phase === "uncertain" && scopeKey(attempt.payload.scope) === scopeKey(scope)),
    ownsAttachment: (attachment) => [...attempts.values()].some((attempt) =>
      attempt.payload.attachments.some((file) => file.id === attachment.id && file.storageRef === attachment.storageRef)),
  };
}

function canRestoreRejectedSubmission(attempt, error) {
  if (error?.workspaceMutationMayHaveCommitted === true) return false;
  if (isDefiniteSubmissionRefusal(error)) return true;
  return attempt.phase === "preparing";
}
