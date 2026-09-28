const exclusionFields = Object.freeze({ collection: "excludedApplications", processing: "processingExcludedApplications" });
const applicationKey = app => app.trim().toLowerCase();

/** Change one permission using current server preferences; other activity rules stay untouched. */
export function learningApplicationPreferenceChange(snapshot, { app, axis, allowed, environmentId }) {
  if (!canChangeApplicationPreferences(snapshot, environmentId)) return null;
  if (!Object.hasOwn(exclusionFields, axis) || typeof allowed !== "boolean") return null;
  if (typeof app !== "string" || !app.trim()) return null;
  const application = snapshot.status.applications.find(item => applicationKey(item.app) === applicationKey(app));
  if (!application) return null;
  const field = exclusionFields[axis];
  const excluded = snapshot.status.preferences[field] ?? [];
  const remaining = excluded.filter(value => applicationKey(value) !== applicationKey(application.app));
  return { [field]: allowed ? remaining : [...remaining, application.app] };
}

function canChangeApplicationPreferences(snapshot, environmentId) {
  if (snapshot.environmentId !== environmentId) return false;
  if (snapshot.saving || snapshot.statusError) return false;
  if (!snapshot.status?.preferences) return false;
  return Array.isArray(snapshot.status.applications);
}
