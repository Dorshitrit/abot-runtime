import { describe, expect, it, vi } from "vitest";
import { projectSessionSnapshot } from "../../sessions/snapshot.js";
import type { SessionRecord, SessionRequestStatus } from "../../sessions/types.js";
// @ts-expect-error Browser-only module.
import { renderAgentSessionPreview } from "../../web-ui/app/components/agents/session-preview.js";

// @ts-expect-error Browser-only module.
import { agentSessionPage, renderAgentSessions } from "../../web-ui/app/components/agents/conversation.js";
// @ts-expect-error Browser-only module.
import { createSessionInspector } from "../../web-ui/app/components/agents/session-inspector.js";

const time = "2026-11-17T00:00:00.000Z";
function snapshot(messages: SessionRecord["messages"], status?: SessionRequestStatus) {
  return projectSessionSnapshot({
    id: "owned-session", title: "Session 1", createdAt: time, updatedAt: time,
    lastAgentMode: "fast", messageCount: messages.length, messages,
    requests: status ? [{
      requestId: "work-request", sessionId: "owned-session", status,
      createdAt: time, updatedAt: time, lastSeqNo: 0, events: [],
    }] : [],
  }, { includeRequests: true });
}

describe("Agent work session inspector", () => {
  it("displays the text projected by the ordinary session service with safe Markdown", () => {
    const session = snapshot([
      { id: "1", role: "user", content: "Check **both** options.", createdAt: time },
      { id: "2", role: "assistant", content: "[Source](https://example.com/) <script>bad()</script>", createdAt: time },
    ], "completed");
    const view = renderAgentSessionPreview({ session });
    expect(view).toContain("Work request");
    expect(view).toContain("<strong>both</strong>");
    expect(view).toContain("Session reply");
    expect(view).toContain('href="https://example.com/"');
    expect(view).toContain("&lt;script&gt;");
    expect(view).not.toContain("<script>");
    expect(view).toContain("Completed");
  });

  it.each([
    ["streaming", "The session is working."],
    ["awaiting_approval", "waiting for approval"],
    ["failed", "request failed"],
    ["completed", "finished without a visible message"],
    [undefined, "No messages have been saved"],
  ] as const)("explains an empty snapshot with request state %s", (status, expected) => {
    expect(renderAgentSessionPreview({ session: snapshot([], status) })).toContain(expected);
  });

  it("distinguishes loading, unavailable history and fetch failure and preserves cached text", () => {
    expect(renderAgentSessionPreview({ session: null, loading: true })).toContain("Loading session history");
    expect(renderAgentSessionPreview({ session: null })).toContain("Session history is unavailable");
    const session = snapshot([{ id: "1", role: "user", content: "Previous snapshot", createdAt: time }]);
    const view = renderAgentSessionPreview({ session, error: "Could not refresh <unsafe>" });
    expect(view).toContain('role="alert"');
    expect(view).toContain("Could not refresh &lt;unsafe&gt;");
    expect(view).toContain("Previous snapshot");
  });

  it("keeps long assignments out of its heading and escapes metadata", () => {
    const label = "<b>Compare options</b> ".repeat(15);
    const view = renderAgentSessionPreview({ session: null, label, status: "<working>" });
    expect(view).toContain("&lt;b&gt;Compare options");
    expect(view).toContain("…</strong>");
    expect(view).toContain("&lt;working&gt;");
    expect(view).not.toContain(label);
    expect(view).toContain('data-agents-action="close-session"');
  });
});

describe("Agent work session pages", () => {
  const sessions = Array.from({length: 103}, (_, i) => ({sessionId: `id-${i}`, purpose: `Work on item ${i}`}));

  it("shows every owned session exactly once from newest to oldest with bounded markup", () => {
    let page = agentSessionPage(sessions);
    const visited: string[] = [];
    expect(page.newer).toBeNull();
    for (;;) {
      const rows: string = renderAgentSessions(page.sessions);
      expect(rows.match(/data-agent-session=/g)?.length).toBeLessThanOrEqual(6);
      expect(rows).not.toMatch(/Session [0-9]+/);
      visited.push(...Array.from(rows.matchAll(/data-agent-session="([^"]+)"/g), (entry) => entry[1] as string));
      if (page.older === null) break;
      page = agentSessionPage(sessions, page.older);
    }
    expect(visited).toEqual(sessions.map((s) => s.sessionId).reverse());
    expect(agentSessionPage(sessions, page.newer).sessions[0].sessionId).toBe("id-1");
    expect(agentSessionPage([])).toMatchObject({sessions:[], newer:null, older:null});
  });

  it("holds an older page in place when a refresh adds a new session", () => {
    const end = agentSessionPage(sessions).older;
    const extended = [...sessions, {sessionId:"new",purpose:"New work"}];
    expect(agentSessionPage(extended, end).sessions).toEqual(agentSessionPage(sessions, end).sessions);
    expect(agentSessionPage(extended).sessions.at(-1).sessionId).toBe("new");
  });

  it("opens the exact selected session under the same descriptive title", async () => {
    const view = {session: vi.fn()};
    const client = {getAgentSession: vi.fn(async () => ({session: snapshot([])}))};
    const inspector = createSessionInspector({client, view, getScope: () => ({selected:"owner",environment:"dev"})});
    await inspector.show("id-17", {sessions, attempts:[]});
    expect(client.getAgentSession).toHaveBeenCalledWith("owner", "id-17", "dev");
    expect(view.session).toHaveBeenLastCalledWith(expect.objectContaining({label:"Work on item 17"}));
  });
});
