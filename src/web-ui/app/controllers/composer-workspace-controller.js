import { createWebSessionId } from "../lib/text-format.js";
import { createComposerDrafts } from "./composer-drafts.js";
import { createComposerDraftView } from "./composer-draft-view.js";

/** Places the shared Home/Chat controls and selects a draft; it owns no payload. */
export function createComposerWorkspaceController({
  state, dom, homeComposerHost, homeSetupHost, selectedEnvironmentId,
  createSessionId = createWebSessionId, onSessionCreated = () => {},
  drafts = createComposerDrafts(),
}) {
  const surfaces = [{ element: dom.composerForm, homeHost: homeComposerHost,
    chatHost: dom.composerForm.parentElement, nextSibling: dom.composerForm.nextSibling }];
  if (homeSetupHost && dom.runtimeSetupGuide) surfaces.push({
    element: dom.runtimeSetupGuide, homeHost: homeSetupHost,
    chatHost: dom.runtimeSetupGuide.parentElement, nextSibling: dom.runtimeSetupGuide.nextSibling,
  });
  const homeSessions = new Map();
  const resetDrafts = new Map();
  const resetHomeDrafts = new Map();
  let workspace = "chat";

  function ensureHomeSession() {
    const environment = selectedEnvironmentId();
    if (homeSessions.has(environment)) return homeSessions.get(environment);
    const session = createSessionId();
    homeSessions.set(environment, session);
    const resetDraft = resetHomeDrafts.get(environment);
    if (resetDraft) {
      drafts.open({ environmentId: environment, sessionId: session }).text = resetDraft.take().text;
      resetHomeDrafts.delete(environment);
    }
    onSessionCreated(session);
    return session;
  }
  const chatDraft = () => drafts.open({ environmentId: selectedEnvironmentId(), sessionId: state.currentSessionId });
  const homeDraft = () => drafts.open({ environmentId: selectedEnvironmentId(), sessionId: ensureHomeSession() });
  const isHome = () => workspace === "home";
  const isChatVisible = () => workspace === "chat";
  const chatView = createComposerDraftView({ input: dom.composerInput, getDraft: chatDraft, isVisible: isChatVisible });
  const homeView = createComposerDraftView({ input: dom.composerInput, getDraft: homeDraft, isVisible: isHome });

  function moveSurface(surface) {
    if (isHome()) { surface.homeHost.appendChild(surface.element); return; }
    const sibling = surface.nextSibling?.parentElement === surface.chatHost ? surface.nextSibling : null;
    surface.chatHost.insertBefore(surface.element, sibling);
  }
  function setWorkspace(next) {
    if (isHome()) homeView.detach();
    else chatView.detach();
    workspace = next;
    if (isHome()) homeView.display();
    else chatView.display();
    for (const surface of surfaces) moveSurface(surface);
  }
  function syncChatDraft() {
    if (isHome()) { homeView.display(); return; }
    chatView.display();
  }
  function resetSessionDraft(scope, deleted) {
    const retireHome = deleted && homeSessions.get(scope.environmentId) === scope.sessionId;
    const displayHome = scope.environmentId === selectedEnvironmentId() && isHome();
    if (retireHome && displayHome) homeView.detach();
    drafts.resetSessionData(scope);
    if (!retireHome) return;
    homeSessions.delete(scope.environmentId);
    resetHomeDrafts.set(scope.environmentId, drafts.open(scope));
    if (displayHome) homeView.display();
  }
  function preserveResetDraft(scope) {
    const ownsCurrentChat = scope.environmentId === selectedEnvironmentId() && scope.sessionId === state.currentSessionId;
    if (ownsCurrentChat) chatView.saveDisplayed();
    const source = drafts.open(scope);
    if (!source.text) return undefined;
    const empty = drafts.open({ environmentId: scope.environmentId, sessionId: "" });
    const target = empty.isEmpty() && !empty.uploading ? empty
      : drafts.open({ environmentId: scope.environmentId, sessionId: createSessionId() });
    if (ownsCurrentChat) chatView.detach();
    target.text = source.take().text;
    resetDrafts.set(scope.environmentId, { draft: target, initialized: !target.scope.sessionId });
    return target.scope.sessionId;
  }
  function restoreResetDraft(savedSessionId) {
    const recovery = resetDrafts.get(selectedEnvironmentId());
    if (!recovery) return false;
    if (recovery.draft.isEmpty() && !recovery.draft.uploading) {
      resetDrafts.delete(selectedEnvironmentId());
      return false;
    }
    if (recovery.draft.scope.sessionId !== savedSessionId) return false;
    if (state.currentSessionId && state.currentSessionId !== savedSessionId) return false;
    state.currentSessionId = savedSessionId;
    if (!recovery.initialized) { onSessionCreated(savedSessionId); recovery.initialized = true; }
    syncChatDraft();
    return true;
  }
  drafts.subscribe((draft) => { chatView.refresh(draft); homeView.refresh(draft); });
  chatView.display();

  return {
    drafts, chatDraft, homeDraft, chatView, homeView,
    chatDom: { ...dom, composerInput: chatView.surface },
    homeDom: { ...dom, composerInput: homeView.surface },
    isHome, isChatVisible, setWorkspace, syncChatDraft, ensureHomeSession, resetSessionDraft, preserveResetDraft, restoreResetDraft,
    composerSessionId: () => isHome() ? ensureHomeSession() : state.currentSessionId,
    finishHomeActivation(scope) {
      if (homeSessions.get(scope.environmentId) === scope.sessionId) homeSessions.delete(scope.environmentId);
    },
  };
}
