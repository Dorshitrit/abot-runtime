import { canViewConversationFile } from "../lib/conversation-file-reference.js";
import { createProjectDiff } from "../components/project-diff.js";

function sameConversation(before, current) {
  return before?.environmentId === current?.environmentId && before?.sessionId === current?.sessionId;
}
function sameRequestOrSettled(before, current) {
  return !current?.activeRequestId || before?.activeRequestId === current.activeRequestId;
}
function isFileModification(action, requestId) {
  if (!["write_file", "edit_file"].includes(action.tool)) return false;
  return canViewConversationFile(action, requestId);
}

function hasTextDiff(change) {
  if (change?.status !== "available" || change.preview?.status !== "text") return false;
  return typeof change.preview.patch === "string";
}

/** A receipt selects the server-authorized current file; it never attributes its diff to this action. */
export function createProjectFileChangesFeature({ client, getScope, documentRoot = document, AbortControllerImpl = globalThis.AbortController }) {
  const operations = new Map();
  let scope = null;
  let active = true;

  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function cancel(entry) {
    entry.version += 1;
    entry.abort?.abort();
    entry.abort = null;
    entry.loading = false;
  }
  function clearResult(entry) {
    cancel(entry);
    entry.result = null;
    entry.error = "";
    entry.attempted = false;
    entry.visible = false;
  }
  function canReadOperation(entry) {
    if (!active) return false;
    if (operations.get(entry.key) !== entry) return false;
    const current = getScope();
    if (!sameConversation(scope, current)) return false;
    return sameRequestOrSettled(scope, current);
  }
  function activate(entry) {
    if (!canReadOperation(entry)) return;
    const mount = entry.mount;
    const visible = mount?.isCurrentAction() && mount.details.open && mount.details.isConnected && !mount.details.closest("[hidden]");
    if (!visible) {
      if (entry.visible) { clearResult(entry); mount?.render(); }
      return;
    }
    entry.visible = true;
    void load(entry);
  }
  function activateVisible() {
    for (const entry of operations.values()) activate(entry);
  }
  function setActive(value) {
    if (active === value) return;
    active = value;
    if (active) { activateVisible(); return; }
    // Workspace navigation keeps the DOM; retain its bindings while invalidating reads.
    for (const entry of operations.values()) {
      clearResult(entry);
      entry.mount?.render();
    }
  }
  function reset() {
    for (const entry of operations.values()) cancel(entry);
    operations.clear();
    scope = null;
  }
  function beginRender() {
    const current = getScope();
    if (!sameConversation(scope, current) || !sameRequestOrSettled(scope, current)) reset();
    if (!scope) scope = { ...current };
    for (const entry of operations.values()) entry.mount = null;
  }
  function finishRender() {
    for (const [key, entry] of operations) {
      if (entry.mount) continue;
      cancel(entry);
      operations.delete(key);
    }
    activateVisible();
  }
  function owns(entry, version, requestScope) {
    if (!canReadOperation(entry)) return false;
    if (operations.get(entry.key) !== entry || entry.version !== version) return false;
    const current = getScope();
    return sameConversation(requestScope, current) && sameRequestOrSettled(requestScope, current);
  }
  async function load(entry) {
    if (!canReadOperation(entry)) return;
    if (entry.loading || entry.attempted) return;
    const requestScope = { ...getScope() };
    if (!requestScope.environmentId || !requestScope.sessionId) return;
    const version = ++entry.version;
    entry.abort = new AbortControllerImpl();
    entry.loading = true;
    entry.attempted = true;
    entry.error = "";
    entry.mount?.render();
    try {
      const response = await client.loadProjectOperationChanges({
        environmentId: requestScope.environmentId, sessionId: requestScope.sessionId,
        requestId: entry.requestId, executionId: entry.executionId, signal: entry.abort.signal,
      });
      if (!owns(entry, version, requestScope)) return;
      entry.result = response.change;
    } catch (error) {
      if (!owns(entry, version, requestScope)) return;
      entry.error = error?.code === "project_changes_stale"
        ? "The file changed while loading. Close and reopen these details to refresh."
        : "Current file changes could not be loaded. Close and reopen these details to try again.";
    }
    if (!owns(entry, version, requestScope)) return;
    entry.loading = false;
    entry.abort = null;
    entry.mount?.render();
  }
  function createNode({ requestId, action, details, isCurrentAction, excerpt }) {
    if (typeof client?.loadProjectOperationChanges !== "function" || !client.supportsProjectChanges()) return null;
    if (!isFileModification(action, requestId)) return null;
    const key = JSON.stringify([requestId, action.fileReference.executionId]);
    const receipt = JSON.stringify(action.fileReference);
    let entry = operations.get(key);
    if (entry && entry.receipt !== receipt) { cancel(entry); operations.delete(key); entry = null; }
    if (!entry) {
      entry = { key, receipt, requestId, executionId: action.fileReference.executionId, version: 0, abort: null,
        loading: false, attempted: false, visible: false, error: "", result: null, mount: null };
      operations.set(key, entry);
    }
    const node = element("div", "conversation-operation-changes");
    const label = element("p", "conversation-tool-preview-label", "Current file changes vs Git HEAD");
    const stats = element("p", "conversation-operation-changes-stats");
    stats.dir = "ltr";
    const status = element("p", "conversation-operation-changes-status");
    status.setAttribute("role", "status");
    const content = element("div", "conversation-operation-changes-content");
    node.append(label, stats, status, content);
    let renderedResult = null;
    const mount = { details, isCurrentAction, render() {
      if (entry.mount !== mount || !isCurrentAction()) return;
      const result = entry.result;
      const available = hasTextDiff(result);
      node.hidden = !available;
      label.textContent = result?.base === "empty" ? "Current file changes · Initial repository" : "Current file changes vs Git HEAD";
      stats.textContent = available && result.file.additions !== null && result.file.deletions !== null
        ? `+${result.file.additions} −${result.file.deletions}` : "";
      stats.hidden = !stats.textContent;
      status.textContent = entry.loading ? "Checking current file changes…" : entry.error;
      if (result?.status === "unchanged") status.textContent = "No current changes for this file.";
      if (result?.status === "unavailable") status.textContent = result.message || "Current file changes are unavailable.";
      status.hidden = !status.textContent;
      content.hidden = !available;
      if (excerpt) excerpt.hidden = available;
      if (available && renderedResult !== result) {
        content.replaceChildren(createProjectDiff({ file: result.preview, documentRoot }));
        renderedResult = result;
      }
    } };
    entry.mount = mount;
    details.addEventListener("toggle", () => {
      if (entry.mount !== mount || !isCurrentAction()) return;
      if (details.open) { activate(entry); return; }
      clearResult(entry);
      mount.render();
    });
    mount.render();
    return node;
  }
  return { createNode, beginRender, finishRender, activateVisible, setActive, reset };
}
