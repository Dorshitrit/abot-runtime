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
  const client = {
    supportsProjectChanges: () => true,
    loadProjectChanges: vi.fn<ProjectChangesClient["loadProjectChanges"]>(async () => ({ ok: true, changes })),
    loadProjectChangeDiff: vi.fn<ProjectChangesClient["loadProjectChangeDiff"]>(async ({ fileId }) => ({ ok: true, file: { id: fileId, path: fileId + ".ts", status: "text", patch: "+new" } })),
  };
  const controller = createProjectChangesController({ client, getScope: () => scope, render: (value) => { state = value; } });
  return { controller, client, get state() { return state; }, scope: (next: Partial<typeof scope>) => { scope = { ...scope, ...next }; } };
}
async function ready(f: ReturnType<typeof fixture>) {
  f.controller.sync({ anchorId: "answer" });
  await vi.waitFor(() => expect(f.state.loading).toBe(false));
}

describe("current project changes lifecycle", () => {
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
  test("new active requests close the preview and old history pages/reset clear state", async () => {
    const f = fixture(); await ready(f); f.controller.open();
    f.scope({ activeRequestId: "new-request" });
    f.controller.sync({ anchorId: "answer" });
    expect(f.state.open).toBe(false);
    await vi.waitFor(() => expect(f.state.loading).toBe(false));
    f.controller.sync({ anchorId: "answer", isLatestWindow: false });
    expect(f.state.anchorId).toBe("");
    expect(f.state.changes).toBeNull();
    f.controller.reset();
    expect(f.state.open).toBe(false);
  });
});
