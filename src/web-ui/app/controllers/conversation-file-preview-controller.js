import { parseConversationFileReference } from "../lib/conversation-file-reference.js";

export function filePreviewErrorMessage(error) {
  if (error?.status === 404) return "This file is no longer available.";
  if (error?.status === 403)
    return "This file is outside the currently allowed folders.";
  if (error?.code === "conversation_file_changed")
    return "The file changed while it was being read. Open it again to view its latest contents.";
  if (error?.code === "conversation_file_root_changed")
    return "The file location has changed. This recorded action can no longer open it.";
  if (error?.status === 413) return "This file is too large to preview.";
  if (error?.status === 415) return "A preview is not available for this file.";
  return "The file could not be loaded. Try opening it again.";
}

function hasConversationScope(scope) {
  if (typeof scope?.environmentId !== "string" || !scope.environmentId)
    return false;
  return typeof scope.sessionId === "string" && Boolean(scope.sessionId);
}

function matchesConversationScope(previous, current) {
  if (previous.environmentId !== current?.environmentId) return false;
  return previous.sessionId === current?.sessionId;
}

function hasNewActiveRequest(previous, current) {
  if (!current?.activeRequestId) return false;
  return current.activeRequestId !== previous.activeRequestId;
}

export function createConversationFilePreviewController({
  client,
  getScope,
  render,
  AbortControllerImpl = globalThis.AbortController,
}) {
  let generation = 0;
  let selection = null;
  let cancellation = null;
  let readyFile = null;
  let nativeOpening = false;

  function close({ restoreFocus = true } = {}) {
    generation += 1;
    cancellation?.abort();
    cancellation = null;
    selection = null;
    readyFile = null;
    nativeOpening = false;
    render({ open: false, restoreFocus });
  }

  function ownsPendingPreview(version, scope) {
    if (generation !== version || !selection) return false;
    const current = getScope();
    if (!matchesConversationScope(scope, current)) return false;
    return !hasNewActiveRequest(scope, current);
  }

  async function open(rawReference, opener) {
    const reference = parseConversationFileReference(rawReference);
    const scope = { ...getScope() };
    if (!reference || !hasConversationScope(scope)) return;
    cancellation?.abort();
    const version = ++generation;
    cancellation = new AbortControllerImpl();
    const input = {
      environmentId: scope.environmentId,
      sessionId: scope.sessionId,
      requestId: reference.requestId,
      executionId: reference.executionId,
    };
    selection = { scope, reference, input, version };
    readyFile = null;
    nativeOpening = false;
    render({
      open: true,
      status: "loading",
      opener,
      name: reference.output.relativePath.split("/").at(-1),
    });
    try {
      const response = await client.loadConversationFile({
        ...input,
        signal: cancellation.signal,
      });
      if (!ownsPendingPreview(version, scope)) return;
      readyFile = response.file;
      render({
        open: true,
        status: "ready",
        file: response.file,
        imageUrl:
          response.file.kind === "image"
            ? client.conversationFileUrl({ ...input, mode: "content" })
            : "",
      });
    } catch (error) {
      if (!ownsPendingPreview(version, scope)) return;
      render({
        open: true,
        status: "error",
        error: filePreviewErrorMessage(error),
      });
    }
  }

  function canOpenSelectedFileOnMac() {
    if (!selection) return false;
    if (readyFile?.nativeOpenAvailable !== true) return false;
    if (typeof client.openConversationFile !== "function") return false;
    if (nativeOpening) return false;
    return ownsPendingPreview(selection.version, selection.scope);
  }

  async function openNative() {
    if (!canOpenSelectedFileOnMac()) return;
    const { scope, input, version } = selection;
    nativeOpening = true;
    render({ open: true, status: "native", nativeStatus: "opening" });
    try {
      await client.openConversationFile({
        ...input,
        signal: cancellation.signal,
      });
      if (!ownsPendingPreview(version, scope)) return;
      render({ open: true, status: "native", nativeStatus: "opened" });
    } catch (error) {
      if (!ownsPendingPreview(version, scope)) return;
      const message =
        error?.status === 404
          ? "This file is no longer available."
          : "The file could not be opened on your Mac.";
      render({
        open: true,
        status: "native",
        nativeStatus: "error",
        nativeError: message,
      });
    } finally {
      if (ownsPendingPreview(version, scope)) nativeOpening = false;
    }
  }

  function syncScope() {
    if (!selection) return;
    const current = getScope();
    if (!matchesConversationScope(selection.scope, current)) {
      close({ restoreFocus: false });
      return;
    }
    if (hasNewActiveRequest(selection.scope, current))
      close({ restoreFocus: false });
  }

  return { open, openNative, close, syncScope };
}
