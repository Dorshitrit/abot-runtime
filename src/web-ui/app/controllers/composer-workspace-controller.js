import { createWebSessionId } from "../lib/text-format.js";

export function createComposerWorkspaceController({
  state,
  dom,
  homeComposerHost,
  homeSetupHost,
  selectedEnvironmentId,
  createSessionId = createWebSessionId,
}) {
  const surfaces = [{
    element: dom.composerForm,
    homeHost: homeComposerHost,
    chatHost: dom.composerForm.parentElement,
    nextSibling: dom.composerForm.nextSibling,
  }];
  if (homeSetupHost && dom.runtimeSetupGuide) {
    surfaces.push({
      element: dom.runtimeSetupGuide,
      homeHost: homeSetupHost,
      chatHost: dom.runtimeSetupGuide.parentElement,
      nextSibling: dom.runtimeSetupGuide.nextSibling,
    });
  }
  const chatDrafts = new Map();
  const homeState = {
    currentSessionId: "",
    activeRequestId: "",
    pendingAttachments: [],
    pendingAttachmentUploadCounts: new Map(),
    composerAttachmentGeneration: 0,
    composerSending: false,
    environmentId: selectedEnvironmentId(),
    text: "",
  };
  let workspace = "chat";
  let displayedSource = "chat";
  let displayedChatKey = currentChatKey();

  function currentChatKey() {
    return JSON.stringify([selectedEnvironmentId(), state.currentSessionId]);
  }

  function saveDisplayedText() {
    if (displayedSource === "home") {
      homeState.text = dom.composerInput.value;
      return;
    }
    chatDrafts.set(displayedChatKey, dom.composerInput.value);
  }

  function isHome() {
    return workspace === "home";
  }

  function isChatVisible() {
    return workspace === "chat";
  }

  function isCurrentChatInputDisplayed() {
    if (displayedSource !== "chat") return false;
    return displayedChatKey === currentChatKey();
  }

  function createInputSurface(source) {
    const parkedStyle = { height: "" };
    const isDisplayed = () =>
      source === "home"
        ? displayedSource === "home"
        : isCurrentChatInputDisplayed();
    const isVisible = () => source === "home" ? isHome() : isChatVisible();
    return {
      get value() {
        if (isDisplayed()) return dom.composerInput.value;
        if (source === "home") return homeState.text;
        return chatDrafts.get(currentChatKey()) || "";
      },
      set value(value) {
        if (source === "home") homeState.text = value;
        else chatDrafts.set(currentChatKey(), value);
        if (isDisplayed()) dom.composerInput.value = value;
      },
      get style() {
        return isDisplayed() ? dom.composerInput.style : parkedStyle;
      },
      get scrollHeight() {
        return isDisplayed() ? dom.composerInput.scrollHeight : 0;
      },
      focus() {
        if (!isVisible()) return;
        if (isDisplayed()) dom.composerInput.focus();
      },
    };
  }

  function ensureHomeSession() {
    if (!homeState.currentSessionId) {
      homeState.currentSessionId = createSessionId();
    }
    return homeState.currentSessionId;
  }

  function moveWorkspaceSurface(surface) {
    if (isHome()) {
      surface.homeHost.appendChild(surface.element);
      return;
    }
    const nextSibling = surface.nextSibling?.parentElement === surface.chatHost
      ? surface.nextSibling
      : null;
    surface.chatHost.insertBefore(surface.element, nextSibling);
  }

  function setWorkspace(nextWorkspace) {
    saveDisplayedText();
    workspace = nextWorkspace;
    displayedSource = isHome() ? "home" : "chat";
    displayedChatKey = currentChatKey();
    dom.composerInput.value = isHome()
      ? homeState.text
      : chatDrafts.get(displayedChatKey) || "";
    if (isHome()) ensureHomeSession();
    for (const surface of surfaces) moveWorkspaceSurface(surface);
  }

  function syncChatDraft() {
    if (displayedSource !== "chat") return;
    if (isCurrentChatInputDisplayed()) return;
    setWorkspace(workspace);
  }

  function resetHomeDraft() {
    homeState.currentSessionId = "";
    homeState.composerSending = false;
    homeState.pendingAttachments = [];
    homeState.composerAttachmentGeneration += 1;
    homeState.pendingAttachmentUploadCounts.clear();
    homeState.environmentId = selectedEnvironmentId();
    homeState.text = "";
    if (displayedSource === "home") dom.composerInput.value = "";
  }

  function takeHomeDraft(text) {
    const draft = {
      sessionId: ensureHomeSession(),
      environmentId: homeState.environmentId,
      text,
      attachments: [...homeState.pendingAttachments],
    };
    resetHomeDraft();
    return draft;
  }

  function restoreHomeDraft(draft) {
    homeState.currentSessionId = draft.sessionId;
    homeState.environmentId = draft.environmentId;
    homeState.pendingAttachments = draft.attachments;
    homeState.text = draft.text;
    if (displayedSource === "home") dom.composerInput.value = draft.text;
  }

  function composerSessionId() {
    return isHome() ? ensureHomeSession() : state.currentSessionId;
  }

  return {
    chatDom: { ...dom, composerInput: createInputSurface("chat") },
    homeDom: { ...dom, composerInput: createInputSurface("home") },
    homeState,
    setWorkspace,
    isHome,
    isChatVisible,
    composerSessionId,
    ensureHomeSession,
    resetHomeDraft,
    takeHomeDraft,
    restoreHomeDraft,
    syncChatDraft,
  };
}
