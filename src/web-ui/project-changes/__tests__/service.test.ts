import { describe, expect, it } from "vitest";
import { access, chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectChangesFixture } from "./fixture.js";
import { authorizeProjectChanges } from "../access.js";

async function listed(fixture: Awaited<ReturnType<typeof projectChangesFixture>>) {
  const result = await fixture.service.list("dev", "session-1");
  expect(result.status, result.message).toBe("available");
  return result;
}
describe("project Git changes", () => {
  it("compares final current files to HEAD across staged, unstaged, untracked and deletion without writes", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("edit.txt", "base\n");
    await fixture.write("delete.txt", "remove\n");
    await fixture.write("restored.txt", "same\n");
    await fixture.commit();
    await fixture.write("edit.txt", "staged\n");
    await fixture.write("restored.txt", "staged\n");
    await fixture.git("add", "--", "edit.txt", "restored.txt");
    await fixture.write("edit.txt", "final\n");
    await fixture.write("restored.txt", "same\n");
    await rm(join(fixture.root, "delete.txt"));
    await fixture.write("new.txt", "new\n");
    const before = await fixture.hashes();
    const changes = await listed(fixture);
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([["delete.txt", "deleted"], ["edit.txt", "modified"], ["new.txt", "untracked"]]);
    expect(changes).toMatchObject({ additions: 2, deletions: 2, base: "head", truncated: false });
    const file = changes.files.find((entry) => entry.path === "edit.txt")!;
    const preview = await fixture.service.file("dev", "session-1", file.id, changes.revision!);
    expect(preview.patch).toContain("-base\n+final\n");
    expect(preview.patch).not.toContain("staged");
    expect(await fixture.hashes()).toEqual(before);
    expect(await readFile(join(fixture.root, "edit.txt"), "utf8")).toBe("final\n");
  });
  it("compares staged deletion plus recreated untracked path exactly once against HEAD", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("recreated.txt", "old\n"); await fixture.commit();
    await fixture.git("rm", "--cached", "--", "recreated.txt");
    await fixture.write("recreated.txt", "replacement\n");
    const changes = await listed(fixture);
    expect(changes.files).toHaveLength(1);
    expect(changes.files[0]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    const preview = await fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!);
    expect(preview.patch).toContain("-old\n+replacement\n");
  });
  it("supports unborn HEAD, empty files, literal unusual filenames and ignored files", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write(".gitignore", "ignored.txt\n");
    await fixture.write("ignored.txt", "private\n");
    for (const path of ["-dash.txt", ":(glob)*.txt", "tab\tline\n.txt", "empty.txt"]) await fixture.write(path, path === "empty.txt" ? "" : "added\n");
    await fixture.git("add", "--", "empty.txt");
    const changes = await listed(fixture);
    expect(changes.base).toBe("empty");
    expect(changes.files.map((file) => file.path)).not.toContain("ignored.txt");
    expect(changes.files.find((file) => file.path === "empty.txt")).toMatchObject({ status: "added", additions: 0, deletions: 0 });
    for (const file of changes.files) {
      const preview = await fixture.service.file("dev", "session-1", file.id, changes.revision!);
      expect(preview.status).toBe("text");
    }
  });
  it("scopes ancestor repositories and cross-boundary rename names to the project subtree", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("project/inside.txt", "inside\n"); await fixture.write("sibling/secret.txt", "SECRET\n"); await fixture.commit();
    fixture.bind(join(fixture.root, "project"));
    await rename(join(fixture.root, "project/inside.txt"), join(fixture.root, "sibling/moved.txt"));
    await fixture.write("sibling/secret.txt", "SECRET CHANGED\n");
    await fixture.git("add", "--all");
    const changes = await listed(fixture);
    expect(changes.files.map((file) => file.path)).toEqual(["inside.txt"]);
    const preview = await fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!);
    expect(JSON.stringify([changes, preview])).not.toMatch(/sibling|SECRET|moved/);
    expect(preview.patch).toContain("-inside");
  });
  it("supports linked worktree .git indirection", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("file.txt", "base\n"); await fixture.commit();
    const worktree = join(fixture.root, "linked");
    await fixture.git("worktree", "add", "-b", "fixture-linked", worktree);
    fixture.bind(worktree); await writeFile(join(worktree, "file.txt"), "linked\n");
    expect((await listed(fixture)).files.map((file) => file.path)).toEqual(["file.txt"]);
  });
  it("bounds binary/large/symlink previews and rejects changed revision", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("base.txt", "base\n"); await fixture.commit();
    await fixture.write("binary.dat", Buffer.from([1, 0, 2]));
    await fixture.write("large.txt", "a".repeat(270000));
    await symlink("base.txt", join(fixture.root, "link.txt"));
    const changes = await listed(fixture);
    for (const [path, status] of [["binary.dat", "binary"], ["large.txt", "too_large"], ["link.txt", "unavailable"]]) {
      const file = changes.files.find((entry) => entry.path === path)!;
      expect((await fixture.service.file("dev", "session-1", file.id, changes.revision!)).status).toBe(status);
    }
    await fixture.write("base.txt", "changed\n");
    await expect(fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!)).rejects.toMatchObject({ code: "project_changes_stale", statusCode: 409 });
  });
  it("preserves a UTF-8 BOM change in the displayed patch", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("bom.txt", "line\n"); await fixture.commit();
    await fixture.write("bom.txt", "\ufeffline\n");
    const changes = await listed(fixture);
    expect(changes.files[0]).toMatchObject({ additions: 1, deletions: 1 });
    const preview = await fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!);
    expect(preview.patch).toContain("+\ufeffline\n");
  });
  it("keeps oversized files visible and honors disabled executable-mode tracking", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("mode.txt", "base\n"); await fixture.commit();
    await fixture.git("config", "core.filemode", "false");
    await chmod(join(fixture.root, "mode.txt"), 0o755);
    await fixture.write("huge.dat", Buffer.alloc(5 * 1024 * 1024, 1));
    const changes = await listed(fixture);
    expect(changes.files.map((file) => file.path)).toEqual(["huge.dat"]);
    expect(changes.files[0]).toMatchObject({ additions: null, deletions: null });
    expect((await fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!)).status).toBe("too_large");
  });
  it("rejects configured filters and partial clones before executing their commands", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("base.txt", "base\n"); await fixture.commit();
    const sentinel = join(fixture.root, "FILTER-RAN");
    await fixture.git("config", "filter.evil.clean", `touch '${sentinel}'`);
    await fixture.write(".gitattributes", "*.txt filter=evil\n");
    await fixture.write("base.txt", "changed\n");
    expect(await fixture.service.list("dev", "session-1")).toMatchObject({ status: "unavailable", message: expect.stringContaining("filters") });
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await fixture.git("config", "--unset", "filter.evil.clean");
    await fixture.git("config", "remote.origin.promisor", "true");
    expect(await fixture.service.list("dev", "session-1")).toMatchObject({ status: "unavailable", message: expect.stringContaining("partial-clone") });
  });
  it("excludes only the root identity marker from changes and totals without changing it", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write(".abot-file-output-root", "internal-original\n");
    await fixture.write(".abot-file-output-root-not", "near-name\n");
    await fixture.write("nested/.abot-file-output-root", "nested-user-file\n");
    await fixture.write("ordinary.txt", "base\n");
    const untracked = await listed(fixture);
    expect(untracked.files.map((file) => file.path)).toEqual([".abot-file-output-root-not", "nested/.abot-file-output-root", "ordinary.txt"]);
    expect(untracked).toMatchObject({ totalFiles: 3, additions: 3, deletions: 0 });
    await fixture.commit();
    await fixture.write(".abot-file-output-root", "internal-updated\nmore internal\n");
    await fixture.write("ordinary.txt", "changed\n");
    const before = await fixture.hashes();
    const modified = await listed(fixture);
    expect(modified.files.map((file) => file.path)).toEqual(["ordinary.txt"]);
    expect(modified).toMatchObject({ totalFiles: 1, additions: 1, deletions: 1 });
    expect(await readFile(join(fixture.root, ".abot-file-output-root"), "utf8")).toBe("internal-updated\nmore internal\n");
    expect(await fixture.hashes()).toEqual(before);
    await rm(join(fixture.root, ".abot-file-output-root"));
    expect((await listed(fixture)).files.map((file) => file.path)).toEqual(["ordinary.txt"]);
  });
  it("rechecks environment/session authority and never creates a missing session", async () => {
    const fixture = await projectChangesFixture();
    const authority = await authorizeProjectChanges(fixture.environments, "dev", "dev", "session-1");
    fixture.disable(); await expect(authority!.assertCurrent()).rejects.toMatchObject({ code: "project_changes_stale" });
    const other = await projectChangesFixture();
    const previous = await authorizeProjectChanges(other.environments, "dev", "dev", "session-1");
    other.remove(); await expect(previous!.assertCurrent()).rejects.toMatchObject({ code: "project_changes_stale" });
    expect(await other.service.list("dev", "session-1")).toMatchObject({ status: "unavailable", files: [] });
    const unbound = await projectChangesFixture(); unbound.unbind();
    expect(await unbound.service.list("dev", "session-1")).toMatchObject({ status: "no_project", revision: null });
  });
});
