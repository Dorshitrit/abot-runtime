import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSparkConversationActions } from "../../web-ui/app/components/spark-conversation-actions.js";
import { normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function setup() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: (key: string) => { data.delete(key); },
  };
  const preferences = createClientPreferences(storage);
  const message = normalizeConversationMessage({
    id: "initiative:p1", role: "assistant", source: "co_worker", content: "An idea",
    initiative: { kind: "proactive_proposal_v1", proposalId: "p1" },
  });
  const state = { environmentId: "dev", sessionId: "spark-one", activeRequestId: "", messages: [message] };
  const archiveSession = vi.fn((id: string) => {
    preferences.saveSessionSidebar(state.environmentId, { archivedSessionIds: [id], orderedSessionIds: [] });
    return true;
  });
  const onArchived = vi.fn(), notify = vi.fn();
  const view = createSparkConversationActions({
    getScope: () => ({ environmentId: state.environmentId, sessionId: state.sessionId }),
    getMessages: () => state.messages,
    getActiveRequestId: () => state.activeRequestId,
    preferences, archiveSession, onArchived, notify,
    documentRoot: { createElement: (tag: string) => new ContextElement(tag) },
  });
  const onKept = vi.fn();
  const render = () => view.createNode(message, { onKept }) as ContextElement | null;
  return { state, message, storage, preferences, archiveSession, onArchived, onKept, notify, render, view };
}

describe("Spark opening conversation actions", () => {
  test("shows both choices for a persisted initiative and keeps only a browser-local receipt", () => {
    const h = setup();
    const node = h.render()!;
    expect(node.children.map((child) => child.textContent)).toEqual(["Keep", "Not interested"]);
    node.children[0].dispatch("click");
    expect(node.hidden).toBe(true);
    expect(h.onKept).toHaveBeenCalledOnce();
    expect(h.preferences.hasKeptSparkConversation("dev", "spark-one")).toBe(true);
    expect(createClientPreferences(h.storage).hasKeptSparkConversation("dev", "spark-one")).toBe(true);
    expect(h.render()).toBeNull();
    expect(h.archiveSession).not.toHaveBeenCalled();
    expect(h.onArchived).not.toHaveBeenCalled();
    expect(h.preferences.loadSessionSidebar("dev").archivedSessionIds).toEqual([]);
  });

  test("Not interested archives exactly once using the existing owner, then leaves the conversation", () => {
    const h = setup();
    const node = h.render()!;
    node.children[1].dispatch("click");
    node.children[1].dispatch("click");
    expect(h.archiveSession).toHaveBeenCalledExactlyOnceWith("spark-one");
    expect(h.onArchived).toHaveBeenCalledOnce();
    expect(h.preferences.loadSessionSidebar("dev").archivedSessionIds).toEqual(["spark-one"]);
    expect(h.render()).toBeNull();
  });

  test("a failed archive or receipt leaves the choices available for retry", () => {
    const h = setup();
    const node = h.render()!;
    h.archiveSession.mockReturnValueOnce(false);
    node.children[1].dispatch("click");
    expect(h.onArchived).not.toHaveBeenCalled();
    expect(node.hidden).toBe(false);
    h.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    node.children[0].dispatch("click");
    expect(node.hidden).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "failed");
    node.children[0].dispatch("click");
    expect(node.hidden).toBe(true);
  });

  test.each(["environmentId", "sessionId"] as const)("ignores stale clicks after %s changes", (field) => {
    const h = setup();
    const node = h.render()!;
    h.state[field] = "other";
    for (const button of node.children) button.dispatch("click");
    expect(h.storage.setItem).not.toHaveBeenCalled();
    expect(h.archiveSession).not.toHaveBeenCalled();
  });

  test("receipts are independent between environments", () => {
    const h = setup();
    h.render()!.children[0].dispatch("click");
    h.state.environmentId = "prod";
    expect(h.render()).not.toBeNull();
  });

  test("only the first assistant proposal is eligible, before any user reply or active request", () => {
    const h = setup();
    const later = { ...h.message, id: "another", sparkProposalId: "p2" };
    h.state.messages.push(later);
    expect(h.view.createNode(later)).toBeNull();
    const node = h.render()!;
    h.state.activeRequestId = "running";
    node.children[1].dispatch("click");
    expect(h.archiveSession).not.toHaveBeenCalled();
    expect(h.render()).toBeNull();
    h.state.activeRequestId = "";
    h.state.messages.push(normalizeConversationMessage({ id: "reply", role: "user", content: "Tell me more" }));
    node.children[0].dispatch("click");
    expect(h.storage.setItem).not.toHaveBeenCalled();
    expect(h.render()).toBeNull();
  });

  test("message identity comes from persisted metadata, never the text or session name", () => {
    const h = setup();
    for (const raw of [
      { source: "co_worker" },
      { source: "runtime", initiative: { kind: "proactive_proposal_v1", proposalId: "p" } },
      { source: "co_worker", initiative: { kind: "other", proposalId: "p" } },
      { source: "co_worker", initiative: { kind: "proactive_proposal_v1", proposalId: " " } },
    ]) {
      const normal = normalizeConversationMessage({ role: "assistant", content: "ABot Spark proposal", ...raw });
      h.state.messages = [normal];
      expect(normal.sparkProposalId).toBe("");
      expect(h.view.createNode(normal)).toBeNull();
    }
    expect(normalizeConversationMessage({ message: {
      role: "assistant", source: "co_worker", initiative: { kind: "proactive_proposal_v1", proposalId: "p" },
    } }).sparkProposalId).toBe("p");
  });

  test("bounds receipts and tolerates malformed stored data", () => {
    const h = setup();
    h.storage.setItem("abot-web.keptSparkConversations", "invalid");
    expect(h.render()).not.toBeNull();
    for (let i = 0; i <= 500; i++) h.preferences.keepSparkConversation("dev", `s${i}`);
    expect(h.preferences.hasKeptSparkConversation("dev", "s0")).toBe(false);
    expect(h.preferences.hasKeptSparkConversation("dev", "s500")).toBe(true);
    expect(h.preferences.hasKeptSparkConversation("prod", "s500")).toBe(false);
  });
});
