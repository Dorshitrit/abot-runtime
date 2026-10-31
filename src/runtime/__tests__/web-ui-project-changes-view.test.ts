import { describe, expect, test, vi } from "vitest";
import { changes, projectChangesFixture as fixture, node, click, pending } from "./support/project-changes-view-fixture.js";

describe("automatic project changes side panel", () => {
  test.each([375, 1400, 1799])("has no below-answer button or automatic summary read at %dpx", (width) => {
    const f = fixture({ width }); f.view.render();
    expect(f.dom.chat.querySelector(".conversation-project-changes")).toBeNull();
    expect(f.client.loadProjectChanges).not.toHaveBeenCalled();
    expect(node(f.dom.host, ".conversation-project-changes-preview").hidden).toBe(true);
  });
  test("opens at 1800px for positive changes without taking composer focus or mutating messages", async () => {
    const f = fixture({ width: 1800 }); const original = structuredClone({ messages: f.messages, events: f.events });
    f.composer.focus(); f.view.render();
    const panel = node(f.dom.host, ".conversation-project-changes-preview");
    await vi.waitFor(() => expect(panel.hidden).toBe(false));
    expect(f.dom.activeElement).toBe(f.composer);
    expect(f.dom.chat.querySelector(".conversation-project-changes-action")).toBeNull();
    expect(f.client.loadProjectChangeDiff).not.toHaveBeenCalled();
    click(node(panel, ".project-changes-file-select"));
    await vi.waitFor(() => expect(panel.querySelector(".project-diff")).not.toBeNull());
    expect(node(panel, ".project-diff").textContent).toContain("+<script>שלום</script>");
    expect(panel.querySelector("script")).toBeNull();
    f.view.render(); expect(f.client.loadProjectChanges).toHaveBeenCalledTimes(1);
    expect({ messages: f.messages, events: f.events }).toEqual(original);
  });
  test.each(["available", "no_project", "not_git", "unavailable"] as const)("keeps initial %s/zero results silent", async (status) => {
    const f = fixture({ width: 1800, summary: { ...changes, status, files: [], totalFiles: 0 } });
    f.view.render(); await vi.waitFor(() => expect(f.client.loadProjectChanges).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(node(f.dom.host, ".conversation-project-changes-preview").hidden).toBe(true);
    expect(f.dom.chat.querySelector(".conversation-project-changes")).toBeNull();
  });
  test("respects manual close across rerenders and closes below the wide threshold", async () => {
    const f = fixture({ width: 1800 }); f.view.render();
    const panel = node(f.dom.host, ".conversation-project-changes-preview");
    await vi.waitFor(() => expect(panel.hidden).toBe(false));
    click(node(panel, ".conversation-file-close")); f.view.render();
    expect(panel.hidden).toBe(true);
    f.resize(1400); expect(panel.hidden).toBe(true);
    f.resize(1900); await vi.waitFor(() => expect(panel.hidden).toBe(false));
    expect(f.client.loadProjectChanges).toHaveBeenCalledTimes(2);
    (node(panel, ".conversation-file-close") as unknown as HTMLElement).focus();
    f.resize(1400); expect(panel.hidden).toBe(true); expect(f.dom.activeElement).toBe(f.composer);
  });
  test("a pending summary and later threshold changes never displace an explicit file preview", async () => {
    const f = fixture({ width: 1900 }); const response = pending<{ ok: boolean; changes: typeof changes }>();
    f.client.loadProjectChanges.mockReturnValueOnce(response.promise); f.view.render();
    click(node(f.dom.chat, ".conversation-tool-file-action"));
    await vi.waitFor(() => expect(f.client.loadConversationFile).toHaveBeenCalledTimes(1));
    response.resolve({ ok: true, changes }); await Promise.resolve();
    const panel = node(f.dom.host, ".conversation-project-changes-preview");
    expect(panel.hidden).toBe(true);
    f.resize(1400); f.resize(1900); await Promise.resolve();
    expect(panel.hidden).toBe(true);
    const file = f.dom.host.querySelectorAll(".conversation-file-preview").find((entry) => !entry.classList.contains("conversation-project-changes-preview"))!;
    expect(file.hidden).toBe(false);
  });
  test("keeps an open refresh usable when the last change disappears and returns focus on close", async () => {
    const f = fixture({ width: 1900 }); f.view.render();
    const panel = node(f.dom.host, ".conversation-project-changes-preview");
    await vi.waitFor(() => expect(panel.hidden).toBe(false));
    f.client.loadProjectChanges.mockResolvedValueOnce({ ok: true, changes: { ...changes, files: [], totalFiles: 0 } });
    const refresh = node(panel, ".conversation-file-mode"); (refresh as unknown as HTMLElement).focus(); click(refresh);
    await vi.waitFor(() => expect(node(panel, ".project-changes-notice").textContent).toBe("No current changes."));
    expect(panel.hidden).toBe(false); click(node(panel, ".conversation-file-close"));
    expect(f.dom.activeElement).toBe(f.composer);
  });
  test("states a truncated list and submodule exclusion and clears old history/workspace panels", async () => {
    const f = fixture({ width: 1900, summary: { ...changes, totalFiles: 201, truncated: true, additions: null, deletions: null } });
    f.view.render(); const panel = node(f.dom.host, ".conversation-project-changes-preview");
    await vi.waitFor(() => expect(panel.hidden).toBe(false));
    expect(panel.textContent).toContain("Showing 1 of 201 files");
    expect(panel.textContent).toContain("Limited file list · Submodule contents excluded");
    f.view.setWorkspace("home"); expect(panel.hidden).toBe(true);
    f.view.setWorkspace("chat"); await vi.waitFor(() => expect(panel.hidden).toBe(false));
    f.view.setHistoryPager({ hasNewer: () => true, renderControls() {} }); f.view.render();
    expect(panel.hidden).toBe(true); f.view.reset();
    expect(panel.querySelector(".project-diff")).toBeNull();
  });
});
