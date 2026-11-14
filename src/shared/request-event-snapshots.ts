/** Only cumulative presentation events may supersede an earlier snapshot. */
export function requestEventSnapshotKey(payload: Record<string, unknown>): string {
  if (payload.type === "token") return "token";
  if (payload.type !== "event") return "";
  if (payload.name !== "thinking.delta") return "";
  if (payload.presentationKind === "acknowledgement") return "";
  return "event:thinking.delta";
}

function hasSameRequestEventScope(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  for (const field of ["requestId", "sessionId", "environment", "environmentId", "generation", "activationId"]) {
    if (previous[field] !== next[field]) return false;
  }
  return true;
}

export function canReplaceRequestEventSnapshot(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): boolean {
  if (!previous) return false;
  const key = requestEventSnapshotKey(previous);
  if (!key) return false;
  if (key !== requestEventSnapshotKey(next)) return false;
  if (!hasSameRequestEventScope(previous, next)) return false;
  if (typeof previous.text !== "string") return false;
  if (typeof next.text !== "string") return false;
  return next.text.startsWith(previous.text);
}

/** Preserve event boundaries and original cursors; replace only the live tail. */
export function appendRequestReplayEvent(
  events: Record<string, unknown>[],
  payload: Record<string, unknown>,
): void {
  if (canReplaceRequestEventSnapshot(events.at(-1), payload)) {
    events[events.length - 1] = payload;
    return;
  }
  events.push(payload);
}

function hasContiguousThinkingDelta(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  if (typeof previous.delta !== "string") return false;
  if (typeof next.delta !== "string") return false;
  if (typeof previous.text !== "string") return false;
  if (typeof next.text !== "string") return false;
  if (next.text.length !== previous.text.length + next.delta.length) return false;
  return next.text.endsWith(next.delta);
}

/** Pending delivery must also preserve the text seen by delta-only clients. */
export function mergePendingRequestSnapshot(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!canReplaceRequestEventSnapshot(previous, next)) return undefined;
  if (next.type === "token") return next;
  if (!hasContiguousThinkingDelta(previous, next)) return undefined;
  return { ...next, delta: String(previous.delta) + String(next.delta) };
}
