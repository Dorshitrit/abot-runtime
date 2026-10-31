import { createProjectChangesController } from "./project-changes-controller.js";
import { createProjectFileChangesFeature } from "./project-file-changes-feature.js";
import { createProjectChangesPreview } from "../components/project-changes-preview.js";
import { hasCompletedConversationAnswer } from "../lib/conversation-final-answer.js";
import { preserveConversationScroll } from "./conversation-file-preview-feature.js";

function latestAnswerIdentity(messages, getActivityForMessage) {
  const answer = [...messages].reverse().find((message) =>
    hasCompletedConversationAnswer(message, getActivityForMessage?.(message)?.events ?? []));
  return answer ? JSON.stringify([answer.requestId || "", String(answer.id)]) : "";
}
function hasProjectChangesDependencies(options) {
  if (typeof options.client?.loadProjectChanges !== "function") return false;
  if (typeof options.client?.loadProjectChangeDiff !== "function") return false;
  return Boolean(options.scrollRoot?.parentElement);
}
function hasPositiveChanges(changes) {
  return changes?.status === "available" && changes.totalFiles > 0;
}

export function createProjectChangesFeature(options) {
  if (!hasProjectChangesDependencies(options)) return { sync() {}, createFileNode: () => null, finishRender() {}, activateVisible() {}, close() {}, reset() {}, setWorkspace() {} };
  const { client, getScope, scrollRoot, documentRoot = document, viewport = window, onBeforeOpen, canAutoOpen = () => true } = options;
  const wideViewport = viewport.matchMedia?.("(min-width: 1800px)");
  const inline = createProjectFileChangesFeature({ client, getScope, documentRoot });
  let activeWorkspace = true;
  let lastInput = null;
  let owner = "";
  let autoSuppressed = false;
  const preview = createProjectChangesPreview({
    host: scrollRoot.parentElement, documentRoot, viewport,
    onClose: () => { autoSuppressed = true; controller.close(); },
    onRefresh: () => controller.refresh(), onSelect: (id) => controller.selectFile(id),
  });
  function shouldAutoOpen(state) {
    if (!activeWorkspace || !wideViewport?.matches || autoSuppressed || !canAutoOpen()) return false;
    if (state.open || state.loading) return false;
    return hasPositiveChanges(state.changes);
  }
  const controller = createProjectChangesController({
    client, getScope,
    render(state) {
      preserveConversationScroll(scrollRoot, () => preview.render(state));
      if (!shouldAutoOpen(state)) return;
      onBeforeOpen?.();
      controller.open();
    },
  });
  function syncPanel(input) {
    const anchorId = latestAnswerIdentity(input.messages, input.getActivityForMessage);
    const scope = getScope();
    const identity = JSON.stringify([scope?.environmentId, scope?.sessionId, anchorId]);
    if (owner !== identity) { owner = identity; autoSuppressed = false; }
    controller.sync({ anchorId: activeWorkspace && wideViewport?.matches ? anchorId : "", isLatestWindow: input.isLatestWindow });
  }
  function sync(input) {
    lastInput = input;
    inline.beginRender();
    syncPanel(input);
  }
  function reset() {
    lastInput = null;
    owner = "";
    autoSuppressed = false;
    inline.reset();
    controller.reset();
  }
  wideViewport?.addEventListener("change", () => {
    if (wideViewport.matches) autoSuppressed = false;
    else controller.close({ restoreFocus: true });
    if (lastInput) syncPanel(lastInput);
  });
  return {
    sync,
    createFileNode: inline.createNode,
    finishRender: inline.finishRender,
    activateVisible: inline.activateVisible,
    close: () => { autoSuppressed = true; controller.close({ restoreFocus: false }); },
    reset,
    setWorkspace(workspace) {
      activeWorkspace = workspace === "chat";
      inline.setActive(activeWorkspace);
      if (!activeWorkspace) { controller.reset(); return; }
      if (lastInput) syncPanel(lastInput);
    },
  };
}
