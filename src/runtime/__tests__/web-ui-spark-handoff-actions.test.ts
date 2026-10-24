import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only presentation module.
import { createSparkHandoffActions } from "../../web-ui/app/components/spark-chat/handoff-actions.js";
// @ts-expect-error Browser navigation controller.
import { createSparkHandoffNavigation } from "../../web-ui/app/controllers/spark-handoff-navigation.js";
import { normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function harness() {
  const message = normalizeConversationMessage({ id: "initiative:p", role: "assistant", source: "co_worker", createdAt: 100,
    initiative: { kind: "proactive_proposal_v1", proposalId: "p", handoffBrief: "An already saved insight", handoffTitle: "The idea" } });
  const scope = { environmentId: "dev", sessionId: "spark-companion", viewVersion: 1 };
  const messages = [message];
  const client = { createSparkHandoffSession: vi.fn(async () => ({ ok: true, sessionId: "ordinary-new" })), postChatMessage: vi.fn() };
  const navigate = vi.fn(async () => true), onOpened = vi.fn(), notify = vi.fn();
  const view = createSparkHandoffActions({ getScope: () => ({ ...scope }), getMessages: () => messages, client,
    captureNavigation: () => navigate, onOpened, notify, documentRoot: { createElement: (tag: string) => new ContextElement(tag) } });
  return { message, scope, messages, client, navigate, onOpened, notify, view, button: () => view.createNode(message).children[0] as ContextElement };
}

describe("explicit SPARK handoff", () => {
  test("one click creates the exact bound ordinary session and waits for the user", async () => {
    const h = harness(); const button = h.button();
    button.dispatch("click"); button.dispatch("click");
    await vi.waitFor(() => expect(h.onOpened).toHaveBeenCalledOnce());
    expect(h.client.createSparkHandoffSession).toHaveBeenCalledExactlyOnceWith({ message: { id: "initiative:p", createdAt: 100, requestId: null } }, "dev");
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith("ordinary-new");
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
  });
  test("legacy suggestions without saved briefs are visible but cannot invent context", () => {
    const h = harness(); h.message.sparkHandoffAvailable = false;
    const row = h.view.createNode(h.message);
    expect(row.children[0].disabled).toBe(true);
    expect(row.textContent).toContain("wasn’t saved");
    row.children[0].dispatch("click");
    expect(h.client.createSparkHandoffSession).not.toHaveBeenCalled();
    expect(h.view.createNode({ ...h.message, sparkProposalId: "" })).toBeNull();
  });
  test("canonical metadata is required and unused brief text stays out of normalized UI state", () => {
    const h = harness(); expect(h.message.sparkHandoffAvailable).toBe(true);
    expect(h.message).not.toHaveProperty("handoffBrief");
    const missing = normalizeConversationMessage({ role: "assistant", source: "co_worker", initiative: { kind: "proactive_proposal_v1", proposalId: "p" } });
    expect(missing.sparkHandoffAvailable).toBe(false);
  });
  test.each(["environment", "clear"])("late results cannot navigate after %s", async (change) => {
    const h = harness(); let resolve!: (value: { ok: boolean; sessionId: string }) => void;
    h.client.createSparkHandoffSession.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    h.button().dispatch("click");
    if (change === "environment") { h.scope.environmentId = "prod"; h.scope.viewVersion++; }
    else h.messages.splice(0);
    resolve({ ok: true, sessionId: "ordinary-new" });
    await vi.waitFor(() => expect(h.client.createSparkHandoffSession).toHaveBeenCalledOnce());
    await Promise.resolve(); expect(h.navigate).not.toHaveBeenCalled(); expect(h.onOpened).not.toHaveBeenCalled();
  });
  test("failed canonical lookup explains the failure without creating or executing a substitute", async () => {
    const h = harness(); h.client.createSparkHandoffSession.mockRejectedValueOnce(new Error("The original suggestion is no longer available."));
    h.button().dispatch("click");
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith("The original suggestion is no longer available.", "failed"));
    expect(h.navigate).not.toHaveBeenCalled(); expect(h.client.postChatMessage).not.toHaveBeenCalled();
  });
  test("the client sends only a bound reference to the selected environment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, sessionId: "ordinary-new" })));
    const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "prod", fetchImpl, origin: "http://localhost" });
    const message = { id: "initiative:p", createdAt: 100, requestId: null };
    await client.createSparkHandoffSession({ message }, "dev");
    expect(fetchImpl.mock.calls[0]![0]).toBe("/web-api/runtime/spark/chat/sessions?environment=dev");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ message });
  });
  test("historical kept and archived receipts remain stored independently", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    const preferences = createClientPreferences(storage);
    const legacyReceipt = JSON.stringify([JSON.stringify(["dev", "old-kept"])]);
    storage.setItem("abot-web.keptSparkConversations", legacyReceipt);
    preferences.saveSessionSidebar("dev", { archivedSessionIds: ["old-dismissed"], orderedSessionIds: [] });
    const restored = createClientPreferences(storage);
    expect(storage.getItem("abot-web.keptSparkConversations")).toBe(legacyReceipt);
    expect(restored.loadSessionSidebar("dev").archivedSessionIds).toEqual(["old-dismissed"]);
  });
});

test("handoff navigation does not replace a workspace selected while the creation was pending", async () => {
  const state = { currentSessionId: "old", sessionViewVersion: 1 };
  let workspace = "home";
  const conversation = { loadSessions: vi.fn(), openSession: vi.fn() };
  const capture = createSparkHandoffNavigation({ state, getEnvironmentId: () => "dev", shell: { activeWorkspace: () => workspace }, conversation, onNavigationChange: vi.fn() });
  const navigate = capture(); workspace = "plugins";
  expect(await navigate("new")).toBe(false); expect(conversation.loadSessions).not.toHaveBeenCalled();
});


test("handoff does not supersede a newer workspace request pending during session refresh", async () => {
  let finishLoad!: () => void, request = 0;
  const conversation = { loadSessions: vi.fn(() => new Promise<void>((resolve) => { finishLoad = resolve; })), openSession: vi.fn() };
  const shell = { activeWorkspace: () => "home", navigationRequestRevision: () => request,
    prepareWorkspaceActivation: vi.fn() };
  const capture = createSparkHandoffNavigation({ state: { currentSessionId: "old", sessionViewVersion: 1 },
    getEnvironmentId: () => "dev", shell, conversation, onNavigationChange: vi.fn() });
  const pending = capture()("new");
  request += 1;
  finishLoad();
  expect(await pending).toBe(false);
  expect(shell.prepareWorkspaceActivation).not.toHaveBeenCalled();
  expect(conversation.openSession).not.toHaveBeenCalled();
});

test("handoff accepts its own workspace request and commits the loaded target", async () => {
  const state = { currentSessionId: "old", sessionViewVersion: 1 };
  let request = 0, workspace = "home";
  const shell = { activeWorkspace: () => workspace, navigationRequestRevision: () => request,
    prepareWorkspaceActivation: async () => { request += 1; return Object.assign(() => { workspace = "chat"; return true; }, { canCommit: () => true }); } };
  const conversation = { loadSessions: vi.fn(), openSession: vi.fn(async (id: string, options: { commitRouteNavigation: () => boolean }) => {
    if (options.commitRouteNavigation()) state.currentSessionId = id;
  }) };
  const capture = createSparkHandoffNavigation({ state, getEnvironmentId: () => "dev", shell, conversation, onNavigationChange: vi.fn() });
  expect(await capture()("new")).toBe(true);
  expect(state.currentSessionId).toBe("new");
  expect(workspace).toBe("chat");
});
