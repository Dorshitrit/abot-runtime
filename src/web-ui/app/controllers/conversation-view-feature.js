import { createConversationView } from "../components/conversation-view.js";
import { createConversationFilePreviewFeature } from "./conversation-file-preview-feature.js";

export function createConversationViewFeature({
  filePreviewClient,
  getFileEnvironmentId,
  getFileSessionId,
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
  return createConversationView({ ...viewOptions, filePreview });
}
