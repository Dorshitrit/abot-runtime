import { describe, expect, test, vi } from "vitest";
import { projectChangesFixture as fixture, operation, node, click, toggleTool, showTimeline, pending } from "./support/project-changes-view-fixture.js";

async function openDetails(f: ReturnType<typeof fixture>) {
  f.view.render(); showTimeline(f); toggleTool(f, true);
  await vi.waitFor(() => expect(node(f.dom.chat, ".conversation-operation-changes").hidden).toBe(false));
}

describe("current file diff inside tool details", () => {
  test("outer Write/Edit disclosure automatically replaces the displayed excerpt with a diff and no inner button", async () => {
    const f = fixture(); const original = structuredClone({ messages: f.messages, events: f.events }); f.view.render();
    expect(f.client.loadProjectOperationChanges).not.toHaveBeenCalled();
    showTimeline(f); expect(f.client.loadProjectOperationChanges).not.toHaveBeenCalled();
    toggleTool(f, true);
    await vi.waitFor(() => expect(node(f.dom.chat, ".conversation-operation-changes").hidden).toBe(false));
    const wrapper = node(f.dom.chat, ".conversation-operation-changes");
    expect(wrapper.hidden).toBe(false);
    expect(node(wrapper, ".conversation-operation-changes-stats").textContent).toBe("+1 −1");
    expect(wrapper.querySelector("button")).toBeNull();
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledWith(expect.objectContaining({ environmentId: "dev", sessionId: "chat", requestId: "last", executionId: "write" }));
    const excerpt = node(f.dom.chat, ".conversation-tool-text-block");
    expect(excerpt.hidden).toBe(true);
    const diff = node(f.dom.chat, ".project-diff");
    expect(diff.getAttribute("aria-label")).toBe("Current changes in notes.txt");
    expect(diff.textContent).toContain("+<script>שלום</script>"); expect(diff.querySelector("script")).toBeNull();
    expect(diff.children[1]?.children.slice(0, 2).map((entry) => entry.textContent)).toEqual(["1", ""]);
    toggleTool(f, false); expect(excerpt.hidden).toBe(false);
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(1);
    expect({ messages: f.messages, events: f.events }).toEqual(original);
  });
  test("coalesces rerenders while open, but genuine details reopen reads current changes again", async () => {
    const f = fixture({ excerpt: "" }); await openDetails(f);
    f.view.render(); f.view.render();
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(1);
    expect(node(f.dom.chat, ".conversation-operation-changes-content").hidden).toBe(false);
    toggleTool(f, false); toggleTool(f, true);
    await vi.waitFor(() => expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2));
  });
  test("workspace return refreshes retained open details without a conversation render, and reopening still works", async () => {
    const f = fixture(); await openDetails(f);
    const details = node(f.dom.chat, ".conversation-tool");
    const wrapper = node(f.dom.chat, ".conversation-operation-changes");
    f.view.setWorkspace("home");
    expect(wrapper.hidden).toBe(true);
    expect(node(f.dom.chat, ".conversation-tool-text-block").hidden).toBe(false);
    f.view.setWorkspace("chat");
    await vi.waitFor(() => expect(wrapper.hidden).toBe(false));
    expect(node(f.dom.chat, ".conversation-tool")).toBe(details);
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2);
    f.view.setWorkspace("chat");
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2);
    toggleTool(f, false); toggleTool(f, true);
    await vi.waitFor(() => expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(3));
  });
  test("workspace pause aborts pending work, blocks hidden toggles/renders, and discards late results", async () => {
    const f = fixture(); const response = pending<{ ok: boolean; change: typeof operation }>();
    f.client.loadProjectOperationChanges.mockReturnValueOnce(response.promise);
    f.view.render(); showTimeline(f); toggleTool(f, true);
    const signal = (f.client.loadProjectOperationChanges.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal;
    f.view.setWorkspace("models"); expect(signal.aborted).toBe(true);
    toggleTool(f, false); toggleTool(f, true); f.view.render();
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(1);
    response.resolve({ ok: true, change: { ...operation, preview: { ...operation.preview!, patch: "+stale response" } } });
    await Promise.resolve(); await Promise.resolve();
    expect(node(f.dom.chat, ".conversation-operation-changes").hidden).toBe(true);
    f.view.setWorkspace("chat");
    await vi.waitFor(() => expect(node(f.dom.chat, ".conversation-operation-changes").hidden).toBe(false));
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2);
    expect(node(f.dom.chat, ".project-diff").textContent).not.toContain("stale response");
  });
  test("returning under another conversation scope cannot activate retained old disclosures", async () => {
    const f = fixture(); await openDetails(f);
    f.view.setWorkspace("home"); f.scope({ environmentId: "prod", sessionId: "other" });
    f.view.setWorkspace("chat"); toggleTool(f, false); toggleTool(f, true);
    expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(1);
    expect(node(f.dom.chat, ".conversation-operation-changes").hidden).toBe(true);
  });
  test("cached-open action inside a collapsed timeline stays unloaded until the timeline opens", async () => {
    const f = fixture(); await openDetails(f);
    click(node(f.dom.chat, ".conversation-work-toggle"));
    f.view.render(); expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(1);
    showTimeline(f); await vi.waitFor(() => expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2));
  });
  test("a failed read is not retried by chat rerenders; explicit reopen can retry", async () => {
    const f = fixture(); f.client.loadProjectOperationChanges.mockRejectedValueOnce(new Error("offline"));
    f.view.render(); showTimeline(f); toggleTool(f, true);
    await vi.waitFor(() => expect(f.dom.chat.textContent).toContain("could not be loaded"));
    f.view.render(); f.view.render(); expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(1);
    toggleTool(f, false); toggleTool(f, true);
    await vi.waitFor(() => expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2));
  });
  test("collapse cancels pending reads and ignores late results from recycled scopes", async () => {
    const f = fixture(); const response = pending<{ ok: boolean; change: typeof operation }>();
    f.client.loadProjectOperationChanges.mockReturnValueOnce(response.promise);
    f.view.render(); showTimeline(f); toggleTool(f, true);
    const signal = (f.client.loadProjectOperationChanges.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal;
    toggleTool(f, false); expect(signal.aborted).toBe(true);
    f.scope({ environmentId: "prod", sessionId: "other" }); f.view.render();
    response.resolve({ ok: true, change: operation }); await Promise.resolve();
    expect(f.dom.chat.querySelector(".project-diff")).toBeNull();
  });
  test("receipt replacement with the same operation IDs invalidates cached output", async () => {
    const f = fixture(); await openDetails(f);
    f.events[0]!.meta!.fileOutput.rootId = "sha256:" + "b".repeat(64);
    f.view.render(); await vi.waitFor(() => expect(f.client.loadProjectOperationChanges).toHaveBeenCalledTimes(2));
  });
  test.each(["read_file", "web_fetch"])("does not offer file changes for %s", (tool) => {
    const f = fixture(); f.events[0]!.tool = tool; f.view.render(); showTimeline(f); toggleTool(f, true);
    expect(f.client.loadProjectOperationChanges).not.toHaveBeenCalled();
    expect(f.dom.chat.querySelector(".conversation-operation-changes")).toBeNull();
  });
  test.each(["unavailable", "unchanged"] as const)("keeps the original excerpt and hides Git UI while pending and after %s", async (status) => {
    const f = fixture(); const response = pending<{ ok: boolean; change: typeof operation }>();
    f.client.loadProjectOperationChanges.mockReturnValueOnce(response.promise);
    f.view.render(); showTimeline(f); toggleTool(f, true);
    const wrapper = node(f.dom.chat, ".conversation-operation-changes");
    const excerpt = node(f.dom.chat, ".conversation-tool-text-block");
    expect(wrapper.hidden).toBe(true);
    expect(excerpt.hidden).toBe(false);
    expect(excerpt.textContent).toContain("Recorded original excerpt");
    response.resolve({ ok: true, change: { ...operation, status, file: null, preview: null, message: "This project has no Git repository." } });
    await vi.waitFor(() => expect(node(wrapper, ".conversation-operation-changes-status").textContent).not.toBe("Checking current file changes…"));
    expect(wrapper.hidden).toBe(true);
    expect(excerpt.hidden).toBe(false);
    expect(excerpt.textContent).toContain("Recorded original excerpt");
    expect(f.dom.chat.querySelector(".project-diff")).toBeNull();
  });
  test.each(["binary", "too_large", "unavailable"] as const)("preserves the original excerpt when the server preview is %s", async (status) => {
    const f = fixture();
    f.client.loadProjectOperationChanges.mockResolvedValueOnce({ ok: true, change: { ...operation, preview: { ...operation.preview!, status, patch: null } } });
    f.view.render(); showTimeline(f); toggleTool(f, true);
    const wrapper = node(f.dom.chat, ".conversation-operation-changes");
    await vi.waitFor(() => expect(node(wrapper, ".conversation-operation-changes-status").textContent).toBe(""));
    expect(wrapper.hidden).toBe(true);
    expect(node(f.dom.chat, ".conversation-tool-text-block").hidden).toBe(false);
    expect(f.dom.chat.querySelector(".project-diff")).toBeNull();
  });
  test("unavailable and unchanged responses preserve recorded evidence without pretending to be an action delta", async () => {
    const f = fixture(); f.client.loadProjectOperationChanges.mockResolvedValueOnce({ ok: true, change: { ...operation, status: "unchanged", file: null, preview: null } });
    f.view.render(); showTimeline(f); toggleTool(f, true);
    await vi.waitFor(() => expect(f.dom.chat.textContent).toContain("No current changes for this file."));
    expect(node(f.dom.chat, ".conversation-tool-text-block").hidden).toBe(false);
    toggleTool(f, false);
    f.client.loadProjectOperationChanges.mockResolvedValueOnce({ ok: true, change: { ...operation, status: "unavailable", file: null, preview: null, message: "Recorded root changed." } });
    toggleTool(f, true); await vi.waitFor(() => expect(f.dom.chat.textContent).toContain("Recorded root changed."));
    expect(node(f.dom.chat, ".conversation-operation-changes").hidden).toBe(true);
  });
});
