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
  let workspace = "chat";

  function ensureHomeSession() {
    const environment = selectedEnvironmentId();
    if (homeSessions.has(environment)) return homeSessions.get(environment);
    const session = createSessionId();
    homeSessions.set(environment, session);
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
  drafts.subscribe((draft) => { chatView.refresh(draft); homeView.refresh(draft); });
  chatView.display();

  return {
    drafts, chatDraft, homeDraft, chatView, homeView,
    chatDom: { ...dom, composerInput: chatView.surface },
    homeDom: { ...dom, composerInput: homeView.surface },
    isHome, isChatVisible, setWorkspace, syncChatDraft, ensureHomeSession,
    composerSessionId: () => isHome() ? ensureHomeSession() : state.currentSessionId,
    finishHomeActivation(scope) {
      if (homeSessions.get(scope.environmentId) === scope.sessionId) homeSessions.delete(scope.environmentId);
    },
  };
}
