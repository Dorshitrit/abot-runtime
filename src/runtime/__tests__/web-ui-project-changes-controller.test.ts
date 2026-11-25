import { describe, expect, test, vi } from "vitest";
import { createProjectChangesController, type ProjectChangesViewState } from "../../web-ui/app/controllers/project-changes-controller.js";
import type { ProjectChanges, ProjectChangesClient } from "../../web-ui/app/services/runtime-web-client/project-changes.js";

const changes: ProjectChanges = {
  status: "available", revision: "rev", base: "head", totalFiles: 2, additions: 2, deletions: 0, truncated: false,
  files: ["one", "two"].map((id) => ({ id, path: id + ".ts", status: "modified" as const, additions: 1, deletions: 0, binary: false })),
};
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let scope = { environmentId: "dev", sessionId: "chat", activeRequestId: "" };
  let state!: ProjectChangesViewState;
  const rendered: ProjectChangesViewState[] = [];
  const client = {
    supportsProjectChanges: () => true,
    loadProjectChanges: vi.fn<ProjectChangesClient["loadProjectChanges"]>(async () => ({ ok: true, changes })),
    loadProjectChangeDiff: vi.fn<ProjectChangesClient["loadProjectChangeDiff"]>(async ({ fileId }) => ({ ok: true, file: { id: fileId, path: fileId + ".ts", status: "text", patch: "+new" } })),
  };
  const controller = createProjectChangesController({ client, getScope: () => scope, render: (value) => { state = value; rendered.push(value); } });
  return { controller, client, rendered, get state() { return state; }, scope: (next: Partial<typeof scope>) => { scope = { ...scope, ...next }; } };
}
async function ready(f: ReturnType<typeof fixture>) {
  f.controller.sync({ anchorId: "answer" });
  await vi.waitFor(() => expect(f.state.loading).toBe(false));
}

describe("current project changes lifecycle", () => {
  test("request and answer refreshes never render a closed panel or discard the previous summary", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    const start = f.rendered.length;
    for (const anchorId of ["answer", "next-answer"]) {
      const next = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
      f.client.loadProjectChanges.mockReturnValueOnce(next.promise);
      f.scope({ activeRequestId: "next-request" });
      f.controller.sync({ anchorId });
      expect(f.state).toMatchObject({ open: true, loading: true, changes, anchorId });
      next.resolve({ ok: true, changes });
      await vi.waitFor(() => expect(f.state.loading).toBe(false));
    }
    expect(f.rendered.slice(start).every(state => state.open && state.changes === changes)).toBe(true);
  });
  test("failed refresh retains previous summary and selection but never a stale diff", async () => {
    const f = fixture(); await ready(f); f.controller.open(); await f.controller.selectFile("one");
    const next = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    f.client.loadProjectChanges.mockReturnValueOnce(next.promise);
    const refresh = f.controller.refresh();
    expect(f.state).toMatchObject({ open: true, loading: true, changes, selectedId: "one", file: null });
    next.reject(new Error("offline")); await refresh;
    expect(f.state).toMatchObject({ open: true, loading: false, changes, selectedId: "one", file: null });
    expect(f.state.error).toContain("Showing previous data");
    await f.controller.selectFile("one");
    expect(f.client.loadProjectChangeDiff).toHaveBeenCalledTimes(1);
  });
  test("refresh reloads retained selection against the new revision and removes absent selection", async () => {
    const f = fixture(); await ready(f); f.controller.open(); await f.controller.selectFile("one");
    f.client.loadProjectChanges.mockResolvedValueOnce({ ok: true, changes: { ...changes, revision: "new" } });
    await f.controller.refresh();
    expect(f.state.selectedId).toBe("one");
    expect(f.state.file?.id).toBe("one");
    expect(f.client.loadProjectChangeDiff).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "new", fileId: "one" }));
    f.client.loadProjectChanges.mockResolvedValueOnce({ ok: true, changes: { ...changes, revision: "removed", totalFiles: 1, files: changes.files.filter(file => file.id !== "one") } });
    await f.controller.refresh();
    expect(f.state).toMatchObject({ open: true, selectedId: "", file: null });
    expect(f.client.loadProjectChangeDiff).toHaveBeenCalledTimes(2);
  });
  test("closing during refresh stays closed and does not reload the selected diff", async () => {
    const f = fixture(); await ready(f); f.controller.open(); await f.controller.selectFile("one");
    const next = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    f.client.loadProjectChanges.mockReturnValueOnce(next.promise);
    const refresh = f.controller.refresh(); f.controller.close();
    next.resolve({ ok: true, changes }); await refresh;
    expect(f.state).toMatchObject({ open: false, selectedId: "one", file: null, loading: false });
    f.scope({ activeRequestId: "later" }); f.controller.sync({ anchorId: "later-answer" });
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    expect(f.state.open).toBe(false);
    expect(f.client.loadProjectChangeDiff).toHaveBeenCalledTimes(1);
  });
  test.each([{ environmentId: "prod" }, { sessionId: "other" }])("scope change clears open state and rejects a late diff: %j", async scope => {
    const f = fixture(); await ready(f); f.controller.open();
    const old = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChangeDiff"]>>>();
    f.client.loadProjectChangeDiff.mockReturnValueOnce(old.promise);
    const detail = f.controller.selectFile("one");
    const signal = f.client.loadProjectChangeDiff.mock.calls[0][0].signal;
    f.scope(scope); f.controller.sync({ anchorId: "answer" });
    expect(f.state).toMatchObject({ open: false, changes: null, selectedId: "", file: null });
    expect(signal?.aborted).toBe(true);
    old.resolve({ ok: true, file: { id: "one", path: "one.ts", status: "text", patch: "old" } }); await detail;
    expect(f.state.file).toBeNull();
  });
  test("same-scope refresh invalidates late details even when the revision is unchanged", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    const old = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChangeDiff"]>>>();
    f.client.loadProjectChangeDiff.mockReturnValueOnce(old.promise);
    const detail = f.controller.selectFile("one");
    const signal = f.client.loadProjectChangeDiff.mock.calls[0][0].signal;
    await f.controller.refresh();
    expect(signal?.aborted).toBe(true);
    old.resolve({ ok: true, file: { id: "one", path: "one.ts", status: "text", patch: "old" } }); await detail;
    expect(f.state.file).toMatchObject({ patch: "+new" });
  });
  test("request guard rejects a summary before sync binds the newer request", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    const next = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    f.client.loadProjectChanges.mockReturnValueOnce(next.promise);
    const refresh = f.controller.refresh();
    f.scope({ activeRequestId: "unbound" });
    next.resolve({ ok: true, changes: { ...changes, revision: "stale" } }); await refresh;
    expect(f.state.changes?.revision).toBe("rev");
    f.controller.sync({ anchorId: "answer" });
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    expect(f.state.open).toBe(true);
  });
  test("coalesces unchanged renders and loads file content only when selected", async () => {
    const f = fixture(); await ready(f);
    f.controller.sync({ anchorId: "answer" });
    expect(f.client.loadProjectChanges).toHaveBeenCalledTimes(1);
    expect(f.client.loadProjectChangeDiff).not.toHaveBeenCalled();
    f.controller.open();
    expect(f.state.open).toBe(true);
    expect(f.client.loadProjectChangeDiff).not.toHaveBeenCalled();
    await f.controller.selectFile("forged");
    expect(f.client.loadProjectChangeDiff).not.toHaveBeenCalled();
    await f.controller.selectFile("one");
    expect(f.client.loadProjectChangeDiff).toHaveBeenCalledWith(expect.objectContaining({ environmentId: "dev", sessionId: "chat", revision: "rev", fileId: "one" }));
    expect(f.state.file?.id).toBe("one");
  });
  test("rejects stale summary responses after scope change and cancels the prior fetch", async () => {
    const f = fixture(); const old = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    f.client.loadProjectChanges.mockReturnValueOnce(old.promise);
    f.controller.sync({ anchorId: "answer" });
    const signal = f.client.loadProjectChanges.mock.calls[0]?.[0].signal;
    f.scope({ environmentId: "prod", sessionId: "other" });
    f.controller.sync({ anchorId: "answer-other" });
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    expect(signal?.aborted).toBe(true);
    old.resolve({ ok: true, changes: { ...changes, revision: "old" } });
    await Promise.resolve();
    expect(f.state.changes?.revision).toBe("rev");
    expect(f.state.anchorId).toBe("answer-other");
  });
  test("accepts a summary when completed-answer rendering precedes active request settlement", async () => {
    const f = fixture(); const result = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    f.scope({ activeRequestId: "completed-request" });
    f.client.loadProjectChanges.mockReturnValueOnce(result.promise);
    f.controller.sync({ anchorId: "answer" });
    f.scope({ activeRequestId: "" });
    result.resolve({ ok: true, changes });
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    expect(f.state.changes).toEqual(changes);
    f.controller.sync({ anchorId: "answer" });
    expect(f.client.loadProjectChanges).toHaveBeenCalledTimes(1);
    f.controller.open();
    expect(f.state.open).toBe(true);
  });
  test("never accepts an earlier request summary after a newer request settles", async () => {
    const f = fixture(); const first = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    const second = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChanges"]>>>();
    f.client.loadProjectChanges.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    f.scope({ activeRequestId: "first" }); f.controller.sync({ anchorId: "answer" });
    f.scope({ activeRequestId: "second" }); f.controller.sync({ anchorId: "answer" });
    f.scope({ activeRequestId: "" });
    second.resolve({ ok: true, changes: { ...changes, revision: "second" } });
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    first.resolve({ ok: true, changes: { ...changes, revision: "first" } });
    await Promise.resolve();
    expect(f.state.changes?.revision).toBe("second");
  });
  test("selection changes and closing invalidate late details even if transport ignores abort", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    const old = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChangeDiff"]>>>();
    f.client.loadProjectChangeDiff.mockReturnValueOnce(old.promise);
    const first = f.controller.selectFile("one");
    const signal = f.client.loadProjectChangeDiff.mock.calls[0]?.[0].signal;
    await f.controller.selectFile("two");
    expect(signal?.aborted).toBe(true);
    old.resolve({ ok: true, file: { id: "one", path: "one.ts", status: "text", patch: "old" } });
    await first;
    expect(f.state.file?.id).toBe("two");
    const closing = pending<Awaited<ReturnType<ProjectChangesClient["loadProjectChangeDiff"]>>>();
    f.client.loadProjectChangeDiff.mockReturnValueOnce(closing.promise);
    const detail = f.controller.selectFile("one"); f.controller.close();
    closing.reject(new Error("late error")); await detail;
    expect(f.state.open).toBe(false); expect(f.state.fileError).toBe("");
  });
  test("refresh changes the revision and stale detail requires explicit refresh", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    f.client.loadProjectChangeDiff.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "project_changes_stale" }));
    await f.controller.selectFile("one");
    expect(f.state.fileError).toContain("Refresh the file list");
    f.client.loadProjectChanges.mockResolvedValueOnce({ ok: true, changes: { ...changes, revision: "new" } });
    await f.controller.refresh();
    expect(f.state.open).toBe(true); expect(f.state.fileError).toBe("");
    await f.controller.selectFile("two");
    expect(f.client.loadProjectChangeDiff).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "new" }));
  });
  test("new active requests retain the preview and old history pages/reset clear state", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    f.scope({ activeRequestId: "new-request" });
    f.controller.sync({ anchorId: "answer" });
    expect(f.state.open).toBe(true);
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    f.controller.sync({ anchorId: "answer", isLatestWindow: false });
    expect(f.state.anchorId).toBe("");
    expect(f.state.changes).toBeNull();
    f.controller.reset();
    expect(f.state.open).toBe(false);
  });
});


// Sending a new message must not close and reopen the current Git sidebar.
import { describe as describeSendPreservation, it as itSendPreservation, expect as expectSendPreservation, vi as viSendPreservation } from "vitest";
import { readFileSync as readSendPreservationSource } from "node:fs";
import { createChatRequestController as createSendPreservationController } from "../../web-ui/app/controllers/chat-request-controller.js";

describeSendPreservation("Git sidebar preservation on chat preparation", () => {
  function setup(current: boolean) {
    const reset = viSendPreservation.fn();
    const applyConversationChrome = viSendPreservation.fn();
    const renderSessions = viSendPreservation.fn();
    const appendLocalUserMessage = viSendPreservation.fn(() => () => {});
    const isCurrentComposerScope = viSendPreservation.fn(() => current);
    const controller = createSendPreservationController({
      client: {
        postChatMessage: viSendPreservation.fn(),
        stopChatRequest: viSendPreservation.fn(),
      },
      conversationView: { reset },
      conversationSession: {
        appendLocalUserMessage,
        activateRequestForScope: viSendPreservation.fn(),
      },
      isCurrentComposerScope,
      applyConversationChrome,
      renderSessions,
    });
    // prepareView only consumes the captured scope and passes the payload through.
    const attempt = { payload: { scope: {} } } as Parameters<typeof controller.prepareView>[0];
    return { controller, attempt, reset, applyConversationChrome, renderSessions, appendLocalUserMessage, isCurrentComposerScope };
  }

  itSendPreservation("preserves project changes while preparing the current composer scope", () => {
    const s = setup(true);
    s.controller.prepareView(s.attempt);
    expectSendPreservation(s.isCurrentComposerScope).toHaveBeenCalledWith(s.attempt.payload.scope);
    expectSendPreservation(s.reset).toHaveBeenCalledExactlyOnceWith({ preserveProjectChanges: true });
    expectSendPreservation(s.applyConversationChrome).toHaveBeenCalledTimes(1);
    expectSendPreservation(s.renderSessions).toHaveBeenCalledTimes(1);
    expectSendPreservation(s.appendLocalUserMessage).toHaveBeenCalledExactlyOnceWith(s.attempt.payload);
  });

  itSendPreservation("does not reset or prepare a stale composer scope", () => {
    const s = setup(false);
    s.controller.prepareView(s.attempt);
    expectSendPreservation(s.isCurrentComposerScope).toHaveBeenCalledWith(s.attempt.payload.scope);
    for (const effect of [s.reset, s.applyConversationChrome, s.renderSessions, s.appendLocalUserMessage]) {
      expectSendPreservation(effect).not.toHaveBeenCalled();
    }
  });

  itSendPreservation("keeps full reset as the default and skips only project changes when requested", () => {
    const source = readSendPreservationSource(new URL("../../web-ui/app/components/conversation-view.js", import.meta.url), "utf8");
    const reset = source.match(/  function reset\(\{ preserveProjectChanges = false \} = \{\}\) \{([\s\S]*?)\n  \}/);
    expectSendPreservation(reset).not.toBeNull();
    expectSendPreservation(reset?.[1].trim()).toBe(`holdingPosition = false;
    renderedMessageLayout = "";
    outsideReasoningBubbles.clear();
    filePreview.reset();
    if (!preserveProjectChanges) projectChanges?.reset();
    viewState.followMessages = true;
    viewState.scrollSettleVersion += 1;
    cancelScheduledMessageRender();
    cancelScheduledThinkingRender();
    conversationActivity.reset();
    conversationReasoning.reset();
    conversationStatus.reset();
    conversationSchedule.reset();
    composerContextWindow.reset();
    composerPlan.reset();
    messageLinkPreviews.reset();`);
  });
});
