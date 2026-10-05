import { AsyncLocalStorage } from "node:async_hooks";

export type AutomationSessionOrigin = Readonly<{
  kind: "automation_node_v1";
  automationId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
}>;

/** Runtime-only authority. A matching JSON object cannot recreate this handle. */
export type AutomationSessionHandle = Readonly<{
  kind: "automation_session_handle";
}>;

type ScopedOrigin = Readonly<{
  sessionId: string;
  origin: AutomationSessionOrigin;
}>;

export class AutomationSessionLockedError extends Error {
  readonly code = "automation_session_locked";

  constructor() {
    super("automation_session_locked");
    this.name = "AutomationSessionLockedError";
  }
}

export function isAutomationSessionLockedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return (
    value.code === "automation_session_locked" ||
    value.message === "automation_session_locked"
  );
}

export function isAutomationSessionOrigin(
  value: unknown,
): value is AutomationSessionOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Partial<AutomationSessionOrigin>;
  return (
    origin.kind === "automation_node_v1" &&
    hasIdentity(origin.automationId) &&
    hasIdentity(origin.runId) &&
    hasIdentity(origin.nodeId) &&
    hasIdentity(origin.attemptId)
  );
}

export function hasAutomationSessionOrigin(
  value: { automationOrigin?: unknown },
): boolean {
  const origin = value.automationOrigin;
  return (
    !!origin &&
    typeof origin === "object" &&
    (origin as { kind?: unknown }).kind === "automation_node_v1"
  );
}

function hasIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function matchesOrigin(
  expected: AutomationSessionOrigin,
  actual: AutomationSessionOrigin,
): boolean {
  return (
    expected.automationId === actual.automationId &&
    expected.runId === actual.runId &&
    expected.nodeId === actual.nodeId &&
    expected.attemptId === actual.attemptId
  );
}

/** One SessionService instance owns its handles and async execution scope. */
export function createAutomationSessionAccess() {
  const scope = new AsyncLocalStorage<ScopedOrigin>();
  const handles = new WeakMap<object, ScopedOrigin>();

  function canAccess(
    sessionId: string,
    record: { automationOrigin?: unknown },
  ): boolean {
    if (!hasAutomationSessionOrigin(record)) return true;
    const current = scope.getStore();
    return (
      current?.sessionId === sessionId &&
      isAutomationSessionOrigin(record.automationOrigin) &&
      matchesOrigin(current.origin, record.automationOrigin)
    );
  }

  return Object.freeze({
    canAccess,
    assertAccess(sessionId: string, record: { automationOrigin?: unknown }) {
      if (!canAccess(sessionId, record))
        throw new AutomationSessionLockedError();
    },
    issue(sessionId: string, origin: AutomationSessionOrigin) {
      if (!isAutomationSessionOrigin(origin))
        throw new Error("automation_session_origin_invalid");
      const handle = Object.freeze({
        kind: "automation_session_handle" as const,
      });
      handles.set(handle, Object.freeze({ sessionId, origin }));
      return handle;
    },
    revoke(handle: AutomationSessionHandle): void {
      handles.delete(handle);
    },
    async run<T>(
      handle: AutomationSessionHandle,
      task: () => Promise<T>,
    ): Promise<T> {
      const accepted = handles.get(handle);
      if (!accepted) throw new AutomationSessionLockedError();
      return await scope.run(accepted, task);
    },
  });
}
