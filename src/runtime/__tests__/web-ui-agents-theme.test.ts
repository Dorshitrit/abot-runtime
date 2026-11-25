import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { transform } from "lightningcss";
// @ts-expect-error Browser-only module.
import { agentColor, renderAgentButton } from "../../web-ui/app/components/agents/appearance.js";
// @ts-expect-error Browser-only module.
import { currentOrbitNotice } from "../../web-ui/app/components/agents/orbit-notices.js";
// @ts-expect-error Browser-only module.
import { selectAgentActivity, renderAgentActivity } from "../../web-ui/app/components/agents/activity-feed.js";
const app = new URL("../../web-ui/app/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, app), "utf8");
describe("Agents palette and doorway regression", () => {
  test("the bare horizontal crew is above Home and never uses the grid icon slot", () => {
    const markup = read("index.html"), begin = markup.indexOf('id="agentsWorkspaceButton"'), end = markup.indexOf("</button>", begin), button = markup.slice(begin, end);
    expect(begin).toBeGreaterThan(0); expect(begin).toBeLessThan(markup.indexOf('id="homeWorkspaceButton"'));
    expect(button).not.toContain("rail-icon");
    expect(button).toContain('class="agents-entry-faces"');
    expect(button.match(/<i>/g)).toHaveLength(3);
    expect(read("agents-feature.js")).not.toContain("homeWorkspacePanel");
    const css = read("styles/57-agents-space.css");
    expect(css).toMatch(/#agentsWorkspaceButton \.agents-entry-faces \{[^}]*flex-direction: row;[^}]*flex-wrap: nowrap;/);
  });
  test("the work halo reflects confirmed, active work for an Agent and its coordinator", () => {
    const agent = { id: "scout", status: "active", workStatus: "working", hasWork: true, mission: { status: "active" }, definition: { name: "Scout" } };
    expect(renderAgentButton(agent, 1)).toContain("is-working");
    expect(renderAgentButton({ ...agent, id: "abot", workStatus: "thinking" }, 0)).toContain("is-working");
    for (const workStatus of ["thinking", "working"]) {
      expect(renderAgentButton({ ...agent, workStatus, hasWork: false }, 1)).not.toContain("is-working");
    }
    for (const workStatus of ["idle", "awaiting_approval", "awaiting_user_decision", "failed"]) {
      expect(renderAgentButton({ ...agent, workStatus }, 1)).not.toContain("is-working");
    }
    expect(renderAgentButton({ ...agent, mission: { status: "completed" } }, 1)).not.toContain("is-working");
  });
  test("orbit notices bind work to the current mission and respect fresh unread replies", () => {
    const first = { id: "u1", missionId: "m1", text: "Compared the options", createdAt: "2026-11-17T10:00:00Z" };
    const reply = { id: "reply-1", missionId: "m1", text: "Here are the results", createdAt: "2026-11-17T10:01:00Z" };
    const agent = { hasWork: true, workStatus: "working", mission: { id: "m1", status: "active" }, latestWorkUpdate: first };
    expect(currentOrbitNotice(agent)).toMatchObject({ id: "u1", kind: "work" });
    expect(currentOrbitNotice({ ...agent, mission: { id: "new", status: "active" } })).toBeNull();
    expect(currentOrbitNotice({ ...agent, latestUnreadReply: reply })).toMatchObject({ id: "reply-1", kind: "reply" });
    expect(currentOrbitNotice({ ...agent, latestUnreadReply: { ...reply, missionId: "older" } })).toMatchObject({ id: "u1" });
    expect(currentOrbitNotice({ workStatus: "idle", latestUnreadReply: reply })).toMatchObject({ id: "reply-1", kind: "reply" });
    expect(currentOrbitNotice({ ...agent, hasWork: false, workStatus: "thinking" })).toMatchObject({ id: "u1", kind: "work" });
    expect(currentOrbitNotice({ ...agent, workStatus: "awaiting_approval" })).toMatchObject({ kind: "approval" });
    for (const workStatus of ["awaiting_user_decision", "failed"])
      expect(currentOrbitNotice({ ...agent, workStatus })).toBeNull();
  });
  test("direct management thinking yields to a fresh reply and disappears outside the current response", () => {
    const thinkingSince = "2026-11-17T10:02:00.000Z";
    const agent = { hasWork: false, workStatus: "thinking", mission: { id: "m2", status: "active" }, thinkingSince };
    const reply = { id: "r1", missionId: "m2", text: "Hi!", createdAt: thinkingSince };
    expect(currentOrbitNotice(agent)).toMatchObject({ kind: "thinking", text: "Thinking…" });
    expect(currentOrbitNotice({ ...agent, latestUnreadReply: { ...reply, createdAt: "2026-11-17T10:01:00.000Z" } })).toMatchObject({ kind: "thinking" });
    expect(currentOrbitNotice({ ...agent, latestUnreadReply: { ...reply, missionId: "previous" } })).toMatchObject({ kind: "thinking" });
    expect(currentOrbitNotice({ ...agent, latestUnreadReply: reply })).toMatchObject({ kind: "reply", text: "Hi!" });
    for (const change of [{ thinkingSince: null }, { hasWork: true }, { workStatus: "working" }, { workStatus: "idle" }, { mission: { status: "completed" } }]) {
      expect(currentOrbitNotice({ ...agent, ...change })).toBeNull();
    }
  });
  test("all Agent surfaces and onboarding inherit the selected palette", () => {
    for (const file of ["57-agents-space.css", "58-agents-conversation.css", "59-agents-onboarding.css"]) {
      const css = read(`styles/${file}`);
      expect(() => transform({ filename: file, code: Buffer.from(css) })).not.toThrow();
      // Fixed colors are only the three semantic avatars and their pupils.
      const paletteColors = css.split("\n").filter((line) => !line.includes(".agents-eyes") && !line.includes(".agents-entry-faces i")).join("\n");
      expect(paletteColors).not.toMatch(/#[\da-f]{3,8}\b/i);
      expect(css).toContain("var(--text)"); expect(css).toContain("var(--muted)");
    }
    expect(read("styles/57-agents-space.css")).toContain("color-mix(in srgb, var(--accent)");
    expect(read("styles/59-agents-onboarding.css")).toContain("background: var(--panel-solid)");
  });
});

describe("Agents recent public activity", () => {
  const update = (id: string, second = 0) => ({ id, text: "Public " + id, createdAt: new Date(1700000000000 + second * 1000).toISOString() });
  const agent = (id: string, updates: unknown[]) => ({ id, status: "active", definition: { name: id }, recentWorkUpdates: updates });
  test("selects the global latest ten stably without mutating or accumulating input", () => {
    const input = [agent("b", Array.from({ length: 8 }, (_, i) => update(String(i), i))), agent("a", Array.from({ length: 8 }, (_, i) => update(String(i), i)))];
    const before = JSON.stringify(input);
    const selected = selectAgentActivity(input);
    expect(selected).toHaveLength(10);
    expect(selected.map((item: { agentId: string; id: string }) => item.agentId + item.id)).toEqual(["a7", "b7", "a6", "b6", "a5", "b5", "a4", "b4", "a3", "b3"]);
    expect(selectAgentActivity(input)).toEqual(selected);
    expect(selectAgentActivity([...input].reverse())).toEqual(selected);
    expect(JSON.stringify(input)).toBe(before);
  });
  test("deduplicates composite identities and excludes archived and deleting agents", () => {
    const one = update("same");
    expect(selectAgentActivity([agent("a", [one, one]), agent("b", [one]), { ...agent("c", [one]), status: "archived" }, { ...agent("d", [one]), isDeleting: true }]).map((item: { agentId: string }) => item.agentId)).toEqual(["a", "b"]);
  });
  test.each(["abot", "research"])("%s activity uses the existing open-Agent action and its orbit color", id => {
    const owner = { ...agent(id, [update("first"), update("second", 1)]), definition: { name: "Research", icon: "pebbles-lilac" } };
    const markup = renderAgentActivity([owner]);
    const buttons = [...markup.matchAll(/<button ([^>]*)>/g)].map(match => match[1]!);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('type="button"');
      expect(button).toContain(`data-agent-id="${id}"`);
      expect(button).toContain(`style="--agent-color:${agentColor(owner)}"`);
      expect(button).not.toContain("onclick");
    }
    expect(renderAgentButton(owner, 1)).toContain(`--agent-color:${agentColor(owner)}`);
  });
  test("navigation identity and unrecognized colors cannot introduce markup or CSS", () => {
    const owner = { ...agent('a" onclick="bad', [update("unsafe")]), definition: { name: "Synthetic", icon: 'pebbles-blue; background: url("private")' } };
    const markup = renderAgentActivity([owner]);
    expect(markup).toContain('data-agent-id="a&quot; onclick=&quot;bad"');
    expect(markup).not.toContain(' onclick="bad');
    expect(markup).not.toContain("background:");
    expect(markup).toContain(`--agent-color:${agentColor(agent("safe", []))}`);
  });
  test("sorts by the numeric instant across timezone offsets with stable equal-time ties", () => {
    const input = [agent("b", [
      { ...update("older"), createdAt: "2026-11-21T01:00:00+03:00" },
      { ...update("same"), createdAt: "2026-11-20T15:00:00-08:00" },
    ]), agent("a", [
      { ...update("tie-b"), createdAt: "2026-11-20T23:00:00Z" },
      { ...update("latest"), createdAt: "2026-11-21T00:00:00Z" },
      { ...update("tie-a"), createdAt: "2026-11-21T01:00:00+02:00" },
    ])];
    const selected = selectAgentActivity(input);
    expect(selected.map((item: { id: string }) => item.id)).toEqual(["latest", "tie-a", "tie-b", "same", "older"]);
    expect(selectAgentActivity([...input].reverse().map(item => ({ ...item, recentWorkUpdates: [...item.recentWorkUpdates].reverse() })))).toEqual(selected);
  });
  test.each([
    ["Pacific/Kiritimati", "2026-11-20T10:30:00Z"],
    ["America/Los_Angeles", "2026-11-20T03:30:00Z"],
  ])("shows a readable local date and time across the date boundary in %s", (timeZone, createdAt) => {
    const DateTimeFormat = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function(locales, options) {
      return new DateTimeFormat(locales ?? "en-GB", { ...options, timeZone });
    });
    try {
      const date = new Date(createdAt);
      const expected = new DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
      const markup = renderAgentActivity([agent("a", [{ ...update("time"), createdAt }])]);
      expect(formatter).toHaveBeenCalledWith(undefined, { dateStyle: "medium", timeStyle: "short" });
      expect(markup).toContain(`datetime="${date.toISOString()}" title="${date.toISOString()}">${expected}</time>`);
      expect(expected).not.toBe(new DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date));
    } finally {
      formatter.mockRestore();
    }
  });
  test("handles empty and malformed histories without using private or unread snapshots", () => {
    for (const input of [undefined, null, {}, [], [null], [agent("a", [null, {}, update(" "), { ...update("x"), text: " " }, { ...update("x"), createdAt: "invalid" }, { ...update("x"), createdAt: Infinity }])], [{ ...agent("a", []), recentWorkUpdates: {}, latestUnreadReply: update("reply"), thinking: "PRIVATE" }]]) {
      expect(selectAgentActivity(input)).toEqual([]);
      expect(renderAgentActivity(input)).toContain("No recent activity.");
    }
  });
  test("escapes public content and preserves delegated attribution and timestamps", () => {
    const input = [{ ...agent("a", [{ ...update("u"), text: '<img src=x onerror="bad">', sourceAgentName: "<delegate>" }]), definition: { name: "<agent>" } }];
    const markup = renderAgentActivity(input);
    expect(markup).toContain("&lt;agent&gt;");
    expect(markup).toContain("&lt;delegate&gt;");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('dir="auto"');
    expect(markup).toContain('datetime="2023-11-14T22:13:20.000Z"');
    expect(renderAgentActivity([])).not.toContain("<li>");
  });
  test("shares a top-aligned rail with approvals and reserves orbit width only for a visible feed", () => {
    const css = read("styles/57-agents-space.css");
    expect(() => transform({ filename: "57-agents-space.css", code: Buffer.from(css) })).not.toThrow();
    expect(css).toContain("container: agents-workspace / inline-size");
    expect(css).toContain(".agents-activity-feed { display: none;");
    expect(css).toContain("@container agents-workspace (min-width: 1100px)");
    expect(css).toContain(".agents-cosmos:has(.agents-activity-feed:not([hidden])) .agents-orbit-field { right: 340px; }");
    expect(css).toMatch(/\.agents-activity-rail \{[^}]*top: 20px;[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: 16px;/);
    expect(css).toContain(".agents-workspace-panel [hidden] { display: none !important; }");
    expect(css).toContain(".agents-approval-tray { flex: none;");
    expect(css).not.toContain("top: 166px");
    expect(css).toContain("max-height: 130px;");
    expect(css).toContain(".agents-activity-item:hover");
    expect(css).toContain(".agents-activity-item:focus-visible");
    const view = read("components/agents/workspace-view.js");
    expect(view).toMatch(/<div class="agents-activity-rail">\s*<aside class="agents-approval-tray"[^>]*><\/aside>\s*<aside class="agents-activity-feed"[^>]*><\/aside>\s*<\/div>/);
    expect(view).toContain('updateMarkup("[data-agents-activity-feed]", renderAgentActivity(agents))');
    expect(view).toContain('query("[data-agents-activity-feed]")]) element.inert = modalOpen');
    expect(view).toContain('query("[data-agents-activity-feed]").hidden = Boolean(selected');
  });
});
