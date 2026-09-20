import { canViewConversationFile } from "../lib/conversation-file-reference.js";

export function createConversationFileAction({
  documentRoot,
  requestId,
  action,
  onOpenFile,
  isCurrentAction,
  canOpenFile = () => true,
}) {
  if (typeof onOpenFile !== "function") return null;
  if (!canOpenFile()) return null;
  if (!canViewConversationFile(action, requestId)) return null;
  const button = documentRoot.createElement("button");
  button.type = "button";
  button.className = "conversation-tool-target conversation-tool-file-action";
  button.setAttribute("dir", "auto");
  button.textContent = action.target || action.fileReference.output.logicalPath;
  button.title = button.textContent;
  button.dataset.requestId = requestId;
  button.dataset.executionId = action.fileReference.executionId;
  button.setAttribute(
    "aria-label",
    "View current file " + action.fileReference.output.relativePath,
  );
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isCurrentAction()) return;
    void onOpenFile(action.fileReference, button);
  });
  return button;
}
