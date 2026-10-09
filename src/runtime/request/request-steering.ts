import {
  createRequestControlDiagnosticId,
  traceRequestControl,
} from "../observability/request-control-diagnostics.js";

export const REQUEST_STEERING_FEATURE = "request_steering_v1" as const;
export const REQUEST_STEERING_MESSAGE_KIND =
  "runtime_active_request_updates_v1" as const;

export type RequestSteeringUpdate = Readonly<{
  steerId: string;
  sequence: number;
  text: string;
}>;

export type RequestSteeringSnapshot = Readonly<{
  version: number;
  updates: readonly RequestSteeringUpdate[];
}>;

export type RequestSteeringAppendResult =
  | Readonly<{
      ok: true;
      duplicate: boolean;
      update: RequestSteeringUpdate;
    }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_steer_request"
        | "request_not_active"
        | "automation_session_locked"
        | "steer_id_conflict";
    }>;

export type RequestSteeringInbox = Readonly<{
  append(
    input: Readonly<{ steerId: string; text: string }>,
  ): RequestSteeringAppendResult;
  bindPersistence(
    persist: (update: RequestSteeringUpdate) => Promise<void>,
  ): void;
  close(): Promise<void>;
  isCurrent(version: number): boolean;
  seal(version: number): boolean;
  snapshot(): RequestSteeringSnapshot;
}>;

const LOG_SCOPE = "runtime.request_steering";

const EMPTY_REQUEST_STEERING_INBOX: RequestSteeringInbox = Object.freeze({
  append: () =>
    Object.freeze({
      ok: false as const,
      reason: "request_not_active" as const,
    }),
  bindPersistence: () => undefined,
  close: async () => undefined,
  isCurrent: (version) => version === 0,
  seal: (version) => version === 0,
  snapshot: () => Object.freeze({ version: 0, updates: Object.freeze([]) }),
});

export function resolveRequestSteeringInbox(
  inbox: RequestSteeringInbox | undefined,
): RequestSteeringInbox {
  return inbox ?? EMPTY_REQUEST_STEERING_INBOX;
}

/** Reconstructs the exact accepted steering prefix for one root activation. */
export function projectRequestSteeringSnapshot(
  inbox: RequestSteeringInbox | undefined,
  version: number,
): RequestSteeringSnapshot {
  const current = resolveRequestSteeringInbox(inbox).snapshot();
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > current.version
  ) {
    throw new Error("request_steering_snapshot_version_invalid");
  }
  return Object.freeze({
    version,
    updates: Object.freeze(current.updates.slice(0, version)),
  });
}

export function createRequestSteeringInbox(params: {
  requestId: string;
  diagnostics?: Readonly<{ inboxId?: string; origin?: string }>;
}): RequestSteeringInbox {
  const diagnosticIdentity = {
    inboxId:
      params.diagnostics?.inboxId ?? createRequestControlDiagnosticId("inbox"),
    inboxOrigin: params.diagnostics?.origin ?? "request",
  };
  const updates: RequestSteeringUpdate[] = [];
  const bySteerId = new Map<string, RequestSteeringUpdate>();
  let closed = false;
  let sealed = false;
  let persistenceBound = false;
  let persistUpdate:
    | ((update: RequestSteeringUpdate) => Promise<void>)
    | undefined;
  let persistenceTail = Promise.resolve();

  traceRequestControl(LOG_SCOPE, "inbox.opened", {
    ...diagnosticIdentity,
    requestId: params.requestId,
  });

  function schedulePersistence(update: RequestSteeringUpdate): void {
    if (!persistUpdate) return;
    const persist = persistUpdate;
    persistenceTail = persistenceTail.then(async () => {
      try {
        await persist(update);
        traceRequestControl(LOG_SCOPE, "update.persisted", {
          ...diagnosticIdentity,
          requestId: params.requestId,
          steerId: update.steerId,
          sequence: update.sequence,
          textLength: update.text.length,
        });
      } catch (error: unknown) {
        traceRequestControl(LOG_SCOPE, "update.persistence_failed", {
          ...diagnosticIdentity,
          requestId: params.requestId,
          steerId: update.steerId,
          sequence: update.sequence,
          errorType:
            error instanceof Error && error.name ? error.name : typeof error,
        });
      }
    });
  }

  return Object.freeze({
    append(input) {
      const steerId = input.steerId.trim();
      const text = input.text.trim();
      if (!steerId || !text) {
        traceRequestControl(LOG_SCOPE, "update.rejected", {
          ...diagnosticIdentity,
          requestId: params.requestId,
          steerId,
          reason: "invalid_steer_request",
          steerIdLength: steerId.length,
          textLength: text.length,
        });
        return Object.freeze({
          ok: false as const,
          reason: "invalid_steer_request" as const,
        });
      }
      const existing = bySteerId.get(steerId);
      if (existing) {
        if (existing.text !== text) {
          traceRequestControl(LOG_SCOPE, "update.rejected", {
            ...diagnosticIdentity,
            requestId: params.requestId,
            steerId,
            reason: "steer_id_conflict",
          });
          return Object.freeze({
            ok: false as const,
            reason: "steer_id_conflict" as const,
          });
        }
        traceRequestControl(LOG_SCOPE, "update.duplicate", {
          ...diagnosticIdentity,
          requestId: params.requestId,
          steerId,
          sequence: existing.sequence,
        });
        return Object.freeze({
          ok: true as const,
          duplicate: true,
          update: existing,
        });
      }
      if (closed || sealed) {
        traceRequestControl(LOG_SCOPE, "update.rejected", {
          ...diagnosticIdentity,
          requestId: params.requestId,
          steerId,
          reason: "request_not_active",
          closed,
          sealed,
        });
        return Object.freeze({
          ok: false as const,
          reason: "request_not_active" as const,
        });
      }

      const update = Object.freeze({
        steerId,
        sequence: updates.length + 1,
        text,
      });
      updates.push(update);
      bySteerId.set(steerId, update);
      schedulePersistence(update);
      traceRequestControl(LOG_SCOPE, "update.accepted", {
        ...diagnosticIdentity,
        requestId: params.requestId,
        steerId,
        sequence: update.sequence,
        textLength: text.length,
        updateCount: updates.length,
      });
      return Object.freeze({
        ok: true as const,
        duplicate: false,
        update,
      });
    },
    bindPersistence(persist) {
      if (persistenceBound) {
        throw new Error("request_steering_persistence_already_bound");
      }
      persistenceBound = true;
      persistUpdate = persist;
      for (const update of updates) {
        schedulePersistence(update);
      }
      traceRequestControl(LOG_SCOPE, "persistence.bound", {
        ...diagnosticIdentity,
        requestId: params.requestId,
        queuedUpdateCount: updates.length,
      });
    },
    async close() {
      if (closed) {
        await persistenceTail;
        return;
      }
      closed = true;
      sealed = true;
      traceRequestControl(LOG_SCOPE, "inbox.closing", {
        ...diagnosticIdentity,
        requestId: params.requestId,
        updateCount: updates.length,
      });
      await persistenceTail;
      traceRequestControl(LOG_SCOPE, "inbox.closed", {
        ...diagnosticIdentity,
        requestId: params.requestId,
        updateCount: updates.length,
      });
    },
    isCurrent(version) {
      return !closed && updates.length === version;
    },
    seal(version) {
      if (closed || sealed || updates.length !== version) {
        traceRequestControl(LOG_SCOPE, "finalization.rejected", {
          ...diagnosticIdentity,
          requestId: params.requestId,
          expectedVersion: version,
          currentVersion: updates.length,
          closed,
          sealed,
        });
        return false;
      }
      sealed = true;
      traceRequestControl(LOG_SCOPE, "finalization.sealed", {
        ...diagnosticIdentity,
        requestId: params.requestId,
        version,
      });
      return true;
    },
    snapshot() {
      return Object.freeze({
        version: updates.length,
        updates: Object.freeze([...updates]),
      });
    },
  });
}
