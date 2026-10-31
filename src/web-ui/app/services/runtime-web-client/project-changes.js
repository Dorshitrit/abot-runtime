const SUMMARY_STATUSES = new Set(["available", "no_project", "not_git", "git_unavailable", "unavailable"]);
const FILE_STATUSES = new Set(["added", "modified", "deleted", "untracked", "conflicted", "type_changed"]);
const DIFF_STATUSES = new Set(["text", "binary", "too_large", "unavailable"]);

function isChangeCount(value) {
  return value === null || Number.isSafeInteger(value) && value >= 0;
}
function isChangeFile(file) {
  if (!file || typeof file.id !== "string" || !file.id) return false;
  if (typeof file.path !== "string" || !file.path) return false;
  if (!FILE_STATUSES.has(file.status)) return false;
  if (typeof file.binary !== "boolean") return false;
  return isChangeCount(file.additions) && isChangeCount(file.deletions);
}
function hasChangesResponse(payload) {
  const changes = payload?.changes;
  if (payload?.ok !== true || !changes) return false;
  if (!SUMMARY_STATUSES.has(changes.status)) return false;
  if (changes.message !== undefined && typeof changes.message !== "string") return false;
  if (changes.revision !== null && typeof changes.revision !== "string") return false;
  if (changes.status === "available" && !changes.revision) return false;
  if (!Array.isArray(changes.files) || !changes.files.every(isChangeFile)) return false;
  if (new Set(changes.files.map((file) => file.id)).size !== changes.files.length) return false;
  if (!Number.isSafeInteger(changes.totalFiles) || changes.totalFiles < changes.files.length) return false;
  if (typeof changes.truncated !== "boolean") return false;
  if (!["head", "empty", null].includes(changes.base)) return false;
  return isChangeCount(changes.additions) && isChangeCount(changes.deletions);
}
function hasDiffResponse(payload, fileId) {
  const file = payload?.file;
  if (payload?.ok !== true || !file) return false;
  if (file.id !== fileId || typeof file.path !== "string") return false;
  if (!DIFF_STATUSES.has(file.status)) return false;
  if (file.message !== undefined && typeof file.message !== "string") return false;
  if (file.status === "text") return typeof file.patch === "string";
  return file.patch === null;
}

function hasOperationResponse(payload) {
  const change = payload?.change;
  if (payload?.ok !== true || !change) return false;
  if (!["available", "unchanged", "unavailable"].includes(change.status)) return false;
  if (!["head", "empty", null].includes(change.base)) return false;
  if (change.revision !== null && typeof change.revision !== "string") return false;
  if (change.message !== undefined && typeof change.message !== "string") return false;
  if (change.status !== "available") return change.file === null && change.preview === null;
  if (!isChangeFile(change.file) || !change.revision || !change.base) return false;
  if (change.preview?.path !== change.file.path) return false;
  return hasDiffResponse({ ok: true, file: change.preview }, change.file.id);
}

export function createProjectChangesRequests({ requestApi, getConfig }) {
  const supportsProjectChanges = () => getConfig()?.backend === "runtime";
  function path(input, detail = false) {
    if (!supportsProjectChanges()) throw new Error("Project changes are unavailable on this backend.");
    const query = new URLSearchParams({ environment: input.environmentId, sessionId: input.sessionId });
    if (detail) {
      query.set("revision", input.revision);
      query.set("fileId", input.fileId);
    }
    return "/chat/project-changes" + (detail ? "/file" : "") + "?" + query;
  }
  async function loadProjectChanges(input) {
    const payload = await requestApi(path(input), { signal: input.signal });
    if (!hasChangesResponse(payload)) throw new Error("Invalid project changes response.");
    return payload;
  }
  async function loadProjectChangeDiff(input) {
    const payload = await requestApi(path(input, true), { signal: input.signal });
    if (!hasDiffResponse(payload, input.fileId)) throw new Error("Invalid project diff response.");
    return payload;
  }
  async function loadProjectOperationChanges(input) {
    const query = new URLSearchParams({ environment: input.environmentId, sessionId: input.sessionId,
      requestId: input.requestId, executionId: input.executionId });
    if (!supportsProjectChanges()) throw new Error("Project changes are unavailable on this backend.");
    const payload = await requestApi("/chat/project-changes/operation?" + query, { signal: input.signal });
    if (!hasOperationResponse(payload)) throw new Error("Invalid operation changes response.");
    return payload;
  }
  return { supportsProjectChanges, loadProjectChanges, loadProjectChangeDiff, loadProjectOperationChanges };
}
