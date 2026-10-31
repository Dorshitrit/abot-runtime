import { describe, expect, test, vi } from "vitest";
import { createProjectChangesRequests, type ProjectChanges } from "../../web-ui/app/services/runtime-web-client/project-changes.js";
import { projectDiffLines } from "../../web-ui/app/lib/project-diff-lines.js";

const changes: ProjectChanges = {
  status: "available", revision: "revision-1", base: "head", totalFiles: 1, additions: 1, deletions: 1, truncated: false,
  files: [{ id: "opaque-file", path: "src/שלום.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
};
const scope = { environmentId: "dev & test", sessionId: "chat/1" };
function fixture(payload: unknown = { ok: true, changes }, backend = "runtime") {
  const requestApi = vi.fn<(path: string, options?: { signal?: AbortSignal }) => Promise<unknown>>(async () => payload);
  return { requestApi, client: createProjectChangesRequests({ requestApi, getConfig: () => ({ backend }) }) };
}

describe("project changes client", () => {
  test("binds GET summary and lazy detail requests to environment/session and server revision/identity", async () => {
    const f = fixture(); const abort = new AbortController();
    expect((await f.client.loadProjectChanges({ ...scope, signal: abort.signal })).changes).toEqual(changes);
    const [path, options] = f.requestApi.mock.calls[0] as unknown as [string, { signal: AbortSignal }];
    const url = new URL(path, "http://local");
    expect(url.pathname).toBe("/chat/project-changes");
    expect(Object.fromEntries(url.searchParams)).toEqual({ environment: scope.environmentId, sessionId: scope.sessionId });
    expect(options.signal).toBe(abort.signal);
    f.requestApi.mockResolvedValue({ ok: true, file: { id: "opaque-file", path: "src/שלום.ts", status: "text", patch: "@@ -1 +1 @@\n-a\n+b\n" } });
    await f.client.loadProjectChangeDiff({ ...scope, revision: "revision-1", fileId: "opaque-file", signal: abort.signal });
    const detail = new URL(String(f.requestApi.mock.calls[1]?.[0]), "http://local");
    expect(detail.pathname).toBe("/chat/project-changes/file");
    expect(Object.fromEntries(detail.searchParams)).toEqual({ environment: scope.environmentId, sessionId: scope.sessionId, revision: "revision-1", fileId: "opaque-file" });
    expect(detail.searchParams.has("path")).toBe(false);
  });
  test("operation lookup sends only canonical receipt IDs and validates the returned file/preview pair", async () => {
    const file = changes.files[0]!;
    const change = { status: "available", file, base: "head", revision: "rev", preview: { id: file.id, path: file.path, status: "text", patch: "+new" } };
    const f = fixture({ ok: true, change }); const abort = new AbortController();
    const input = { ...scope, requestId: "request/1", executionId: "exec & 1", signal: abort.signal };
    expect((await f.client.loadProjectOperationChanges(input)).change).toEqual(change);
    const [path, options] = f.requestApi.mock.calls[0]!;
    const url = new URL(path, "http://local");
    expect(url.pathname).toBe("/chat/project-changes/operation");
    expect(Object.fromEntries(url.searchParams)).toEqual({ environment: scope.environmentId, sessionId: scope.sessionId, requestId: input.requestId, executionId: input.executionId });
    expect(options?.signal).toBe(abort.signal);
    f.requestApi.mockResolvedValueOnce({ ok: true, change: { ...change, preview: { ...change.preview, id: "other" } } });
    await expect(f.client.loadProjectOperationChanges(input)).rejects.toThrow("Invalid operation");
    f.requestApi.mockResolvedValueOnce({ ok: true, change: { ...change, status: "unchanged", file: null, preview: null } });
    expect((await f.client.loadProjectOperationChanges(input)).change.status).toBe("unchanged");
  });
  test("bridge mode cannot dispatch Git reads", async () => {
    const f = fixture(undefined, "bridge");
    expect(f.client.supportsProjectChanges()).toBe(false);
    await expect(f.client.loadProjectChanges(scope)).rejects.toThrow("unavailable");
    expect(f.requestApi).not.toHaveBeenCalled();
  });
  test.each([
    { ...changes, revision: null }, { ...changes, totalFiles: -1 },
    { ...changes, files: [changes.files[0], changes.files[0]] },
    { ...changes, files: [{ ...changes.files[0], additions: -1 }] },
  ])("rejects malformed summary data", async (invalid) => {
    await expect(fixture({ ok: true, changes: invalid }).client.loadProjectChanges(scope)).rejects.toThrow("Invalid");
  });
  test("rejects a detail response for another file and preserves backend stale errors", async () => {
    const f = fixture({ ok: true, file: { id: "other", path: "other", status: "text", patch: "" } });
    const input = { ...scope, revision: "revision-1", fileId: "opaque-file" };
    await expect(f.client.loadProjectChangeDiff(input)).rejects.toThrow("Invalid");
    const stale = Object.assign(new Error("Refresh"), { status: 409, code: "project_changes_stale" });
    f.requestApi.mockRejectedValue(stale);
    await expect(f.client.loadProjectChangeDiff(input)).rejects.toBe(stale);
  });
});

describe("unified diff display rows", () => {
  test("numbers context, additions and removals across hunks without interpreting source HTML", () => {
    const rows = projectDiffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,2 +2,2 @@\n same\n-old\n+<script>שלום</script>\n\\ No newline at end of file\n@@ -10,0 +11,1 @@\n+new\n");
    expect(rows.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine])).toEqual([
      ["meta", null, null], ["meta", null, null], ["meta", null, null], ["hunk", null, null],
      ["context", 2, 2], ["deleted", 3, null], ["added", null, 3], ["meta", null, null],
      ["hunk", null, null], ["added", null, 11],
    ]);
    expect(rows[6]?.text).toBe("+<script>שלום</script>");
  });
  test("handles initial files, deletions and empty patches", () => {
    expect(projectDiffLines("@@ -0,0 +1,1 @@\n+created\n").at(-1)).toMatchObject({ oldLine: null, newLine: 1 });
    expect(projectDiffLines("@@ -1,1 +0,0 @@\n-deleted\n").at(-1)).toMatchObject({ oldLine: 1, newLine: null });
    expect(projectDiffLines("")).toEqual([]);
  });
});
