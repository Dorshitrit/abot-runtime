import { mkdir, symlink, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  captureExecFilesystemSnapshot,
  diffExecFilesystemSnapshots,
} from "../../../plugins/exec/source/filesystem-observer.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);
describe.skipIf(process.platform !== "win32")(
  "Windows EXEC filesystem evidence",
  () => {
    test("observes creation, same-size edits and removal from file metadata", async () => {
      const context = await createPortablePluginFixture("exec");
      const root = context.runtimePaths.agentWorkDir;
      await mkdir(root);
      const file = join(root, "result.txt");
      const empty = await captureExecFilesystemSnapshot(root, ".");
      await writeFile(file, "before");
      const created = await captureExecFilesystemSnapshot(root, ".");
      expect(created.complete).toBe(true);
      expect(
        diffExecFilesystemSnapshots(empty, created).actions,
      ).toContainEqual({
        type: "write_file",
        target: "result.txt",
        details: "exec_filesystem_created",
      });
      await writeFile(file, "edited");
      const newer = new Date(created.entries.get("result.txt")!.mtimeMs + 2000);
      await utimes(file, newer, newer);
      const changed = await captureExecFilesystemSnapshot(root, ".");
      expect(
        diffExecFilesystemSnapshots(created, changed).changedEntryCount,
      ).toBe(1);
      await rm(file);
      const removed = await captureExecFilesystemSnapshot(root, ".");
      expect(
        diffExecFilesystemSnapshots(changed, removed).actions,
      ).toContainEqual({
        type: "refine_target",
        target: "result.txt",
        details: "exec_filesystem_removed",
      });
    });

    test("records a junction without scanning its target", async () => {
      const context = await createPortablePluginFixture("exec");
      const root = context.runtimePaths.agentWorkDir;
      const outside = context.runtimePaths.workspaceDir;
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, "private.txt"), "private");
      await symlink(outside, join(root, "external"), "junction");
      const snapshot = await captureExecFilesystemSnapshot(root, ".");
      expect(snapshot.complete).toBe(true);
      expect([...snapshot.entries.keys()]).toEqual(["external"]);
      expect(snapshot.entries.get("external")).toMatchObject({
        kind: "symlink",
      });
    });
  },
);
