import { ContextElement } from "../../../runtime/__tests__/support/composer-context-window-dom.js";
import { vi } from "vitest";
import { createComposerFeature } from "../../app/controllers/composer-feature.js";
import { createConversationSessionController } from "../../app/controllers/conversation-session-controller.js";
// @ts-expect-error Browser state.
import { createAppState } from "../../app/app-state.js";
import { createComposerWorkspaceController } from "../../app/controllers/composer-workspace-controller.js";
// @ts-expect-error Browser module.
import { createWorkspaceStateStorage } from "../../app/services/workspace-state-storage.js";
// @ts-expect-error Browser module.
import { createServerComposerQueue } from "../../app/services/server-composer-queue.js";
import { createRuntimeWebClient } from "../../app/services/runtime-web-client.js";
import { createHomeComposerFeature } from "../../app/controllers/home-composer-feature.js";
// @ts-expect-error Browser production navigation adapter.
import { createHomeConversationActivation } from "../../app/controllers/home-conversation-activation.js";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function composerProductFixture(options: { fetchImpl?: typeof fetch } = {}) {
  const document = { createElement: (tag: string): any => element(tag) };
  function element(tag: string): any {
    const node = Object.assign(new ContextElement(tag), {
      ownerDocument: document, value: "", scrollHeight: 48, innerHTML: "", nextSibling: null, focus: vi.fn(),
    });
    Object.assign(node.style, { height: "" });
    return Object.assign(node, { insertBefore: (child: ContextElement) => node.appendChild(child) });
  }
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const host = element("div");
  const form = element("form");
  host.appendChild(form);
  const dom = { composerForm: form, composerInput: element("textarea"), attachmentButton: element("button"), attachmentPreview: element("div") };
  const state = createAppState();
  state.currentSessionId = "chat-1";
  let environment = "prod";
  let currentWorkspace = "chat";
  const getEnvironmentId = () => environment;
  const workspace = createComposerWorkspaceController({ state, dom, homeComposerHost: element("div"),
    selectedEnvironmentId: getEnvironmentId, createSessionId: () => "home-1" });
  const requests: Array<Record<string, unknown>> = [];
  const stored = { version: 1, revision: 0, introductionSeen: true, preferences: {}, queue: "" };
  const fetchImpl = options.fetchImpl || (vi.fn(async (_url, input) => {
    if (String(_url) === "/web-ui-state") return new Response(JSON.stringify({ state: stored }));
    requests.push(JSON.parse(String(input?.body)));
    return new Response(JSON.stringify({ requestId: "request-1" }));
  }) as typeof fetch);
  const storage = createWorkspaceStateStorage({ fetchImpl });
  await storage.refresh();
  const queueStore = createServerComposerQueue(storage);
  const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId,
    origin: "http://localhost", fetchImpl });
  const activated: string[] = [];
  let composer: any;
  const statuses: string[] = [];
  const session = createConversationSessionController({
    state, dom: { ...dom, sessionTitle: element("span") }, client,
    selectedEnvironmentId: getEnvironmentId, sessionQueue: queueStore,
    preferences: { saveSessionIdForEnvironment: vi.fn(), sessionIdForEnvironment: () => state.currentSessionId },
    sessions: { byId: vi.fn(), titleOf: () => "Conversation", setCurrentTitle: vi.fn(), applyTitle: vi.fn(), applyReadState: vi.fn() },
    conversationView: { reset: vi.fn() }, applyConversationChrome: vi.fn(), applyModelSelection: vi.fn(),
    renderSessions: vi.fn(), renderMessages: vi.fn(), updateComposerSendState: () => composer?.changed(),
    setMessageStatus: vi.fn(), sendRealtime: () => true, handleRealtimeMessage: vi.fn(),
    recordEvent: vi.fn(), recordControlEvent: vi.fn(), reportQueueFailure: vi.fn(),
    drainQueuedMessage: (input: any) => composer.queue.drain(input),
    suspendQueueRecovery: () => true, recoverBlockedQueue: (scope: any) => composer.queue.recoverForManualSend(scope),
    isCurrentComposerScope: (scope: any) => environment === scope.environmentId && state.currentSessionId === scope.sessionId,
    scheduleTask: vi.fn(), isConversationVisible: () => false, createSessionId: () => "new-chat",
  } as any);
  const activateRequest = session.activateRequestForScope;
  session.activateRequestForScope = (scope, requestId) => {
    activated.push(requestId);
    activateRequest(scope, requestId);
  };
  const shell = {
    showToast: vi.fn(), navigationRevision: () => 0,
    prepareWorkspaceActivation: (destination: string) => () => { currentWorkspace = destination; workspace.setWorkspace(destination); return true; },
  };
  composer = createComposerFeature({ state, dom: workspace.chatDom, shell, client, sessionQueue: queueStore,
    drafts: (workspace as any).drafts, getDraft: (workspace as any).chatView.current,
    conversationSession: session, conversationView: { reset: vi.fn() }, getEnvironmentId,
    ensureSession: session.ensureSession, getSettings: () => ({ agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: { profileId: "model" } }),
    steer: vi.fn(async () => {}), composerActions: { primaryAction: () => "send", render: vi.fn() },
    selectedModelSupportsImageInput: () => true, isComposerAvailable: () => true, getSubmissionBlock: () => null,
    onSubmissionBlocked: vi.fn(), isVisible: workspace.isChatVisible,
    renderSessions: vi.fn(), renderMessages: vi.fn(), applyConversationChrome: vi.fn(),
    setMessageStatus: (message: string) => statuses.push(message), recordControlEvent: vi.fn(), confirmReview: () => true,
  });
  const home = createHomeComposerFeature({ workspace, composer,
    selectedModelSupportsImageInput: () => true,
    activateHomeSession: createHomeConversationActivation({ state, shell, conversationSession: session, composerQueue: composer.queue,
      preferences: { saveSessionIdForEnvironment: vi.fn() }, selectedEnvironmentId: getEnvironmentId,
      renderSessions: vi.fn(), renderMessages: vi.fn(), applyModelSelection: vi.fn(), setCurrentTitle: vi.fn(),
      updateComposerSendState: () => workspace.syncChatDraft(),
    }),
  } as any);
  return {
    document, dom, state, workspace: workspace as any, composer, home, storage, queueStore, client,
    requests, activated, statuses, session, fetchImpl,
    type(text: string) { dom.composerInput.value = text; dom.composerInput.dispatch("input"); },
    switchSession(sessionId: string, targetEnvironment = environment) {
      environment = targetEnvironment;
      state.currentSessionId = sessionId;
      workspace.syncChatDraft();
    },
    showHome() { currentWorkspace = "home"; home.setWorkspace("home"); },
    activeWorkspace: () => currentWorkspace,
  };
}
