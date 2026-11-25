import { isDeepStrictEqual } from "node:util";
import { ClientStateError } from "./contracts.js";
export const AGENT_DRAFT_PREFERENCE = "abot-web.agentDrafts";
export function assertAgentDraftPreference(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientStateError("invalid_preferences", "Agent drafts must be an object.");
  const entries = Object.entries(value);
  if (entries.length > 500) throw new ClientStateError("invalid_preferences", "Too many saved Agent drafts.");
  for (const [key, entry] of entries) {
    let scope: unknown;
    try { scope = JSON.parse(key); } catch { throw new ClientStateError("invalid_preferences", "Invalid Agent draft scope."); }
    if (!Array.isArray(scope) || scope.length !== 2 || scope.some((item) => typeof item !== "string" || !item || item.length > 512))
      throw new ClientStateError("invalid_preferences", "Invalid Agent draft scope.");
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ClientStateError("invalid_preferences", "Invalid Agent draft.");
    const draft = entry as Record<string, unknown>;
    if (Object.keys(draft).some((field) => !["text", "pendingId", "intent", "onboarding"].includes(field))) throw new ClientStateError("invalid_preferences", "Unknown Agent draft field.");
    for (const field of ["text", "pendingId", "onboarding"]) {
      if (typeof draft[field] !== "string" || draft[field].length > (field === "pendingId" ? 128 : 20000)) throw new ClientStateError("invalid_preferences", "Invalid Agent draft text.");
    }
    if (draft.intent !== "auto" && draft.intent !== "task" && draft.intent !== "message") throw new ClientStateError("invalid_preferences", "Invalid Agent draft intent.");
  }
}

/** Text, intent, and receipt identity form one atomic draft. Other scopes can merge. */
export function mergeAgentDraftPreference(before: unknown, after: unknown, current: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return current;
  const conflict = () => { throw new ClientStateError("preferences_changed", "This Agent draft changed in another window. Reload before sending or saving again.", 409); };
  if (after === undefined) {
    if (isDeepStrictEqual(current, before) || current === undefined) return undefined;
    return conflict();
  }
  const previous = (before ?? {}) as Record<string, unknown>;
  const requested = after as Record<string, unknown>;
  const latest = (current ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = Object.assign(Object.create(null), latest);
  const own = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(requested)])) {
    const from = own(previous, key), to = own(requested, key), actual = own(latest, key);
    if (isDeepStrictEqual(from, to)) continue;
    if (!isDeepStrictEqual(actual, from) && !isDeepStrictEqual(actual, to)) conflict();
    if (to === undefined) delete merged[key];
    else merged[key] = structuredClone(to);
  }
  return merged;
}
