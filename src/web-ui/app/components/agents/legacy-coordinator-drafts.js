/** Only this migration knows the former coordinator identity. */
const LEGACY_COORDINATOR_ID = "spark";
const COORDINATOR_ID = "abot";
const CONFLICT = "agents_legacy_draft_conflict";
const fields = ["text", "pendingId", "intent", "onboarding"];
export function isLegacyCoordinatorDraftConflict(error) { return error?.code === CONFLICT; }
export function coordinatorDraftScope(values, environment, id) {
  const key = JSON.stringify([environment, id]);
  if (id !== COORDINATOR_ID && !id.startsWith(`${COORDINATOR_ID}:`)) return { key, value: values[key] };
  const legacyId = `${LEGACY_COORDINATOR_ID}${id.slice(COORDINATOR_ID.length)}`;
  const legacyKey = JSON.stringify([environment, legacyId]);
  if (!Object.hasOwn(values, legacyKey)) return { key, value: values[key] };
  const legacy = values[legacyKey], current = values[key];
  if (current && fields.some((field) => current[field] !== legacy[field])) {
    const error = new Error("Two different saved ABot drafts exist after the coordinator rename. Both are preserved. Choose which draft to use; the other stays available in Saved drafts.");
    error.code = CONFLICT;
    error.collision = { environment, id, key, legacyKey, current, legacy };
    throw error;
  }
  return { key, legacyKey, value: current || legacy };
}
