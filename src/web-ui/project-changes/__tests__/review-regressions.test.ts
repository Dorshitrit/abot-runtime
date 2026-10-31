import { describe, expect, it } from "vitest";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { projectChangesFixture } from "./fixture.js";
import { authorizeProjectChanges } from "../access.js";
import { readProjectFileState, type ProjectFileState } from "../file-state.js";
import { openProjectGitRepository } from "../repository.js";
import { readProjectChangesSnapshot } from "../read-list.js";

async function listed(fixture: Awaited<ReturnType<typeof projectChangesFixture>>) {
  const result = await fixture.service.list("dev", "session-1");
  expect(result.status, result.message).toBe("available");
  return result;
}

function matchingIndexStat(oid: string, state: ProjectFileState): Buffer {
  const [ctime, mtime, dev, ino, size] = state.identity!;
  const timestamp = (value: string) => `${BigInt(value) / 1000000000n}:${BigInt(value) % 1000000000n}`;
  return Buffer.from(`100644 ${oid} 0\tfile.txt\0  ctime: ${timestamp(ctime!)}\n  mtime: ${timestamp(mtime!)}\n  dev: ${dev}\tino: ${ino}\n  uid: 0\tgid: 0\n  size: ${size}\tflags: 0\n`);
}

describe("project changes review regressions", () => {
  it("uses only owner execute permission for Git file mode", async () => {
    const fixture = await projectChangesFixture();
    await fixture.git("config", "core.filemode", "true");
    await fixture.write("mode.txt", "same\n");
    await chmod(join(fixture.root, "mode.txt"), 0o644);
    await fixture.commit();
    for (const mode of [0o645, 0o654, 0o655]) {
      await chmod(join(fixture.root, "mode.txt"), mode);
      expect((await listed(fixture)).files).toEqual([]);
    }
    await chmod(join(fixture.root, "mode.txt"), 0o744);
    const changes = await listed(fixture);
    expect(changes.files[0]).toMatchObject({ path: "mode.txt", additions: 0, deletions: 0 });
    const preview = await fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!);
    expect(preview.patch).toContain("old mode 100644\nnew mode 100755");
    await fixture.git("add", "--", "mode.txt");
    await fixture.git("commit", "-m", "Executable baseline");
    await chmod(join(fixture.root, "mode.txt"), 0o655);
    const removed = await listed(fixture);
    const removedPreview = await fixture.service.file("dev", "session-1", removed.files[0]!.id, removed.revision!);
    expect(removedPreview.patch).toContain("old mode 100755\nnew mode 100644");
  });

  it("retains an unresolved conflict without presenting a header-only diff as text", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("conflict.txt", "base\n"); await fixture.commit();
    await fixture.git("checkout", "-b", "other");
    await fixture.write("conflict.txt", "other\n"); await fixture.commit();
    await fixture.git("checkout", "main");
    await fixture.write("conflict.txt", "ours\n"); await fixture.commit();
    await expect(fixture.git("merge", "--no-edit", "other")).rejects.toThrow();
    await fixture.write("conflict.txt", "ours\n");
    const before = await fixture.hashes();
    const changes = await listed(fixture);
    expect(changes.files).toHaveLength(1);
    expect(changes.files[0]).toMatchObject({ path: "conflict.txt", status: "conflicted", additions: null, deletions: null });
    const preview = await fixture.service.file("dev", "session-1", changes.files[0]!.id, changes.revision!);
    expect(preview).toMatchObject({ status: "unavailable", patch: null, message: expect.stringContaining("unresolved conflict") });
    expect(await fixture.hashes()).toEqual(before);
    await fixture.write("conflict.txt", "different\n");
    const changed = await listed(fixture);
    expect(changed.files[0]).toMatchObject({ status: "conflicted", additions: 1, deletions: 1 });
    expect((await fixture.service.file("dev", "session-1", changed.files[0]!.id, changed.revision!)).patch).toContain("-ours\n+different\n");
  });

  it("ignores opaque untracked nested repositories without hiding ordinary files", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("visible.txt", "base\n"); await fixture.commit();
    await fixture.git("init", "-b", "main", "nested");
    await fixture.write("nested/private.txt", "NESTED CONTENT\n");
    await fixture.git("-C", "nested", "add", "--all");
    await fixture.git("-C", "nested", "commit", "-m", "Nested baseline");
    await fixture.write("visible.txt", "changed\n");
    expect(await fixture.git("ls-files", "--others", "--exclude-standard", "-z")).toContain("nested/\0");
    const changes = await listed(fixture);
    expect(changes.files.map((file) => file.path)).toEqual(["visible.txt"]);
    expect(changes).toMatchObject({ totalFiles: 1, additions: 1, deletions: 1 });
    expect(JSON.stringify(changes)).not.toMatch(/nested|NESTED/);
  });

  it.each([0n, -1n])("reads dirty content when matching file stats are racy against index delta %s", async (delta) => {
    const fixture = await projectChangesFixture();
    await fixture.write("file.txt", "base\n"); await fixture.commit();
    const oid = (await fixture.git("rev-parse", "HEAD:file.txt")).trim();
    await fixture.write("file.txt", "next\n");
    const authority = (await authorizeProjectChanges(fixture.environments, "dev", "dev", "session-1"))!;
    const repository = await openProjectGitRepository(authority);
    const state = await readProjectFileState(fixture.root, "file.txt");
    const matchingStat = matchingIndexStat(oid, state);
    const snapshot = await readProjectChangesSnapshot(authority, {
      ...repository,
      indexMtimeNs: BigInt(state.identity![1]!) + delta,
      git: async (args, options) => {
        const result = await repository.git(args, options);
        return args[0] === "ls-files" && args.includes("--stage") ? { ...result, stdout: matchingStat } : result;
      },
    });
    expect(snapshot.changes.files[0]).toMatchObject({ path: "file.txt", additions: 1, deletions: 1 });
    expect(snapshot.previews.get(snapshot.changes.files[0]!.id)?.patch).toContain("-base\n+next\n");
  });
});
