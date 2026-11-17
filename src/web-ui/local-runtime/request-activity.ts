import type { ActiveRequest, JsonObject } from "./contracts.js";

type Scope = { requestId: string; sessionId: string; environment: string };
type Activity = {
  scope: Scope;
  active: boolean;
  generation?: string;
  revision?: number;
  startedAt: number;
  lastEventAt: number;
  lastEventName: string;
};

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function scopeOf(payload: JsonObject): Scope | undefined {
  if (!nonempty(payload.requestId) || !nonempty(payload.sessionId)) return;
  if (!nonempty(payload.environment)) return;
  return { requestId: payload.requestId, sessionId: payload.sessionId, environment: payload.environment };
}

function key(scope: Scope): string {
  return JSON.stringify([scope.environment, scope.sessionId, scope.requestId]);
}

function handleScope(handle: ActiveRequest): Scope {
  return { requestId: handle.requestId, sessionId: handle.sessionId, environment: handle.environmentId };
}

function terminalScope(payload: JsonObject, handle?: ActiveRequest): Scope | undefined {
  if (!handle) return;
  const scope = handleScope(handle);
  for (const field of ["requestId", "sessionId", "environment"] as const) {
    if (payload[field] !== undefined && payload[field] !== scope[field]) return;
  }
  return scope;
}

function lifecycleOf(payload: JsonObject, scope: Scope): JsonObject | undefined {
  const value = payload.lifecycle;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const lifecycle = value as JsonObject;
  if (lifecycle.schemaVersion !== 1 || lifecycle.requestId !== scope.requestId) return;
  if (lifecycle.sessionId !== scope.sessionId || !nonempty(lifecycle.generation)) return;
  if (payload.generation !== undefined && payload.generation !== lifecycle.generation) return;
  if (!Number.isSafeInteger(lifecycle.revision) || Number(lifecycle.revision) < 0) return;
  if (!["streaming", "awaiting_approval", "completed", "failed"].includes(String(lifecycle.status))) return;
  return lifecycle;
}

/** Display inventory only. Ordered live lifecycle events never create execution handles. */
export class RequestActivity {
  private readonly records = new Map<string, Activity>();

  observe(payload: JsonObject, handle?: ActiveRequest): void {
    const terminal = payload.type === "completed" || payload.type === "failed";
    const scope = scopeOf(payload) ?? (terminal ? terminalScope(payload, handle) : undefined);
    if (!scope) return;
    const id = key(scope);
    const previous = this.records.get(id);
    const matchingHandle = handle && key(handleScope(handle)) === id ? handle : undefined;
    let active = previous?.active;
    let generation = previous?.generation;
    let revision = previous?.revision;

    if (payload.name === "request.lifecycle.changed") {
      const lifecycle = lifecycleOf(payload, scope);
      if (!lifecycle) return;
      if (generation && generation !== lifecycle.generation) return;
      if (revision !== undefined && revision >= Number(lifecycle.revision)) return;
      active = lifecycle.status === "streaming";
      generation = String(lifecycle.generation);
      revision = Number(lifecycle.revision);
    } else if (terminal) {
      if (generation && payload.generation !== undefined && payload.generation !== generation) return;
      active = false;
    } else if (!previous) {
      return;
    }

    // Inactive overrides suppress an unsettled handle, then disappear with it.
    // Producers deliver live events in order; no completed-request history is kept.
    if (!active && !matchingHandle) {
      this.records.delete(id);
      return;
    }
    const now = Date.now();
    this.records.set(id, {
      scope, active: active === true, generation, revision,
      startedAt: previous?.startedAt ?? matchingHandle?.startedAt ?? now,
      lastEventAt: now,
      lastEventName: String(payload.name || payload.type || "event"),
    });
  }

  release(handle: ActiveRequest | undefined): void {
    if (!handle) return;
    const id = key(handleScope(handle));
    if (this.records.get(id)?.active === false) this.records.delete(id);
  }

  details(handles: JsonObject[]): JsonObject[] {
    const details = new Map<string, JsonObject>();
    for (const handle of handles) {
      const scope = scopeOf(handle);
      if (scope) details.set(key(scope), handle);
    }
    for (const [id, record] of this.records) {
      if (!record.active) {
        details.delete(id);
        continue;
      }
      details.set(id, {
        ...record.scope,
        startedAt: record.startedAt,
        lastEventAt: record.lastEventAt,
        lastEventName: record.lastEventName,
        idleMs: Date.now() - record.lastEventAt,
      });
    }
    return [...details.values()];
  }
}
