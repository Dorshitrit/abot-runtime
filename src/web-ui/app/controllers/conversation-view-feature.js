import { createConversationView } from "../components/conversation-view.js";
import { createConversationFilePreviewFeature } from "./conversation-file-preview-feature.js";
import { createSparkConversationActions } from "../components/spark-conversation-actions.js";

export function createConversationViewFeature({
  filePreviewClient,
  getFileEnvironmentId,
  getFileSessionId,
  preferences,
  archiveSession,
  onSparkArchived,
  ...viewOptions
}) {
  const {
    dom,
    getActiveRequestId,
    documentRoot = document,
    viewport = window,
  } = viewOptions;
  const filePreview = createConversationFilePreviewFeature({
    client: filePreviewClient,
    getScope: () => ({
      environmentId: getFileEnvironmentId?.(),
      sessionId: getFileSessionId?.(),
      activeRequestId: getActiveRequestId?.(),
    }),
    scrollRoot: dom.messagesList,
    documentRoot,
    viewport,
  });
  const sparkActions = createSparkConversationActions({
    getScope: () => ({ environmentId: getFileEnvironmentId?.(), sessionId: getFileSessionId?.() }),
    getMessages: viewOptions.getMessages,
    getActiveRequestId,
    preferences,
    archiveSession,
    onArchived: onSparkArchived,
    notify: viewOptions.notify,
    documentRoot,
  });
  return createConversationView({ ...viewOptions, filePreview, sparkActions });
}
