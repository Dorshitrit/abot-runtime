import { createConversationFilePreview } from "../components/conversation-file-preview.js";
import { createConversationFilePreviewController } from "./conversation-file-preview-controller.js";

function hasFilePreviewDependencies(options) {
  if (!options.client?.loadConversationFile) return false;
  if (typeof options.getScope !== "function") return false;
  return Boolean(options.scrollRoot?.parentElement);
}

function preserveConversationScroll(scrollRoot, change) {
  const top = scrollRoot.scrollTop;
  const left = scrollRoot.scrollLeft;
  const bounds = scrollRoot.getBoundingClientRect();
  const anchor = [...scrollRoot.querySelectorAll(".message-row")].find(
    (node) => node.getBoundingClientRect().bottom > bounds.top,
  );
  const previousOffset = anchor?.getBoundingClientRect().top;
  change();
  if (anchor?.isConnected && previousOffset !== undefined) {
    scrollRoot.scrollTop =
      top + anchor.getBoundingClientRect().top - previousOffset;
    scrollRoot.scrollLeft = left;
    return;
  }
  scrollRoot.scrollTop = top;
  scrollRoot.scrollLeft = left;
}

export function createConversationFilePreviewFeature(options) {
  if (!hasFilePreviewDependencies(options)) {
    return {
      open: undefined,
      canOpen: () => false,
      reset() {},
      syncScope() {},
      setWorkspace() {},
    };
  }
  const { client, getScope, scrollRoot, documentRoot, viewport } = options;
  const host = scrollRoot.parentElement;
  const view = createConversationFilePreview({
    host,
    documentRoot,
    viewport,
    onClose: () => controller.close(),
    onOpenNative: () => controller.openNative(),
  });
  const controller = createConversationFilePreviewController({
    client,
    getScope,
    render: (state) =>
      preserveConversationScroll(scrollRoot, () => view.render(state)),
  });
  return {
    open: controller.open,
    canOpen: client.supportsConversationFiles,
    reset: () => controller.close({ restoreFocus: false }),
    syncScope: controller.syncScope,
    setWorkspace(workspace) {
      if (workspace !== "chat") controller.close({ restoreFocus: false });
    },
  };
}
