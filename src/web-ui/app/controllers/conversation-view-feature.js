import { createProjectChangesFeature } from "./project-changes-feature.js";
import { createConversationView } from "../components/conversation-view.js";
import { createConversationFilePreviewFeature } from "./conversation-file-preview-feature.js";

export function createConversationViewFeature({
  filePreviewClient,
  getFileEnvironmentId,
  getFileSessionId,
  sparkActions = { createNode: () => null },
  ...viewOptions
}) {
  const {
    dom,
    getActiveRequestId,
    documentRoot = document,
    viewport = window,
  } = viewOptions;
  let projectChanges;
  const getScope = () => ({
    environmentId: getFileEnvironmentId?.(),
    sessionId: getFileSessionId?.(),
    activeRequestId: getActiveRequestId?.(),
  });
  const filePreview = createConversationFilePreviewFeature({
    client: filePreviewClient,
    getScope,
    onBeforeOpen: () => projectChanges?.close(),
    scrollRoot: dom.messagesList,
    documentRoot,
    viewport,
  });
  projectChanges = createProjectChangesFeature({
    client: filePreviewClient, getScope, scrollRoot: dom.messagesList, documentRoot, viewport,
    onBeforeOpen: filePreview.reset,
    canAutoOpen: () => !filePreview.isOpen(),
  });
  return createConversationView({ ...viewOptions, filePreview, projectChanges, sparkActions });
}
