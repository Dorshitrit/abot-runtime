export function showWorkspaceStorageFailure(error, documentRoot = document) {
  let notice = documentRoot.querySelector("[data-workspace-storage-error]");
  if (!notice) {
    notice = documentRoot.createElement("div");
    notice.dataset.workspaceStorageError = "";
    notice.setAttribute("role", "alert");
    notice.className = "workspace-storage-failure";
    documentRoot.body.append(notice);
  }
  notice.textContent = `${error.message} Changes are not confirmed. Reload before sending more messages.`;
}
