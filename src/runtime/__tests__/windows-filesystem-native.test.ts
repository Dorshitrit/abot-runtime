import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import { readMutationSnapshot } from "../../../plugins/filesystem/source/bounded-io.js";
import {
  writeWindowsFile,
  readWindowsFileSlices,
} from "../../../plugins/filesystem/source/windows/operations.js";
import { runWindowsFilesystem } from "../../../plugins/filesystem/source/windows/process.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const require = createRequire(import.meta.url);
afterEach(removePortablePluginFixtures);

async function fixture(bundled = false) {
  const context = await createPortablePluginFixture("filesystem");
  await mkdir(context.runtimePaths.agentWorkDir, { recursive: true });
  await mkdir(context.runtimePaths.workspaceDir, { recursive: true });
  const create = bundled
    ? (require(join(process.cwd(), "plugins/filesystem/src/index.cjs"))
        .default as RuntimePluginEntrypointFactory)
    : createFilesystemPlugin;
  const plugin = create(context);
  return {
    context,
    plugin,
    root: context.runtimePaths.agentWorkDir,
    target: (path: string) => context.runtimePathResolver.resolve(path),
  };
}

describe.skipIf(process.platform !== "win32")(
  "native Windows filesystem",
  () => {
    test.each([false, true])(
      "real read, create, scoped edit, and directory sample (bundle=%s)",
      async (bundled) => {
        const { plugin, root } = await fixture(bundled);
        expect(
          await plugin.handlers.write_file!({
            path: "nested/שלום.txt",
            content: "alpha\nbeta\ngamma",
          }),
        ).toMatchObject({ ok: true });
        expect(
          await plugin.handlers.read_file!({ path: "nested/שלום.txt" }),
        ).toMatchObject({ ok: true });
        expect(
          await plugin.handlers.edit_file!({
            path: "nested/שלום.txt",
            instruction: "Replace line two.",
            selection: JSON.stringify({
              placement: "replace",
              start_line: 2,
              end_line: 2,
            }),
            content: "changed",
          }),
        ).toMatchObject({ ok: true });
        expect(await readFile(join(root, "nested/שלום.txt"), "utf8")).toBe(
          "alpha\nchanged\ngamma",
        );
        const listing = await plugin.handlers.dev_view!({ path: "nested" });
        expect(listing).toMatchObject({ ok: true });
        expect(listing.output).toContain("שלום.txt");
        expect(listing.output).not.toContain(root);
      },
      30_000,
    );

    test("bounded text preserves head/tail and binary or oversized edits leave files untouched", async () => {
      const { plugin, root } = await fixture();
      await writeFile(join(root, "large.txt"), "a".repeat(1_048_577));
      const read = await plugin.handlers.read_file!({ path: "large.txt" });
      expect(read).toMatchObject({ ok: true, data: { bytesRead: 36_864 } });
      expect(read.output).toContain("View: bounded head/tail");
      expect(
        await plugin.handlers.write_file!({
          path: "large.txt",
          content: "replacement",
        }),
      ).toMatchObject({ ok: false, errorCode: "file_too_large" });
      await writeFile(join(root, "binary.txt"), Buffer.from([0, 255]));
      expect(
        await plugin.handlers.write_file!({
          path: "binary.txt",
          content: "replacement",
        }),
      ).toMatchObject({ ok: false, errorCode: "binary_file_unsupported" });
      expect(await readFile(join(root, "binary.txt"))).toEqual(
        Buffer.from([0, 255]),
      );
    }, 20_000);

    test("refuses stale replacement and a target created since observation", async () => {
      const { target, root } = await fixture();
      await writeFile(join(root, "note.txt"), "original");
      const resolved = target("note.txt");
      const snapshot = await readMutationSnapshot(resolved);
      await writeFile(join(root, "note.txt"), "user changed");
      await expect(
        writeWindowsFile({
          target: resolved,
          content: "overwrite",
          expectedVersion: snapshot.version,
        }),
      ).rejects.toMatchObject({ code: "filesystem_target_changed" });
      await expect(
        writeWindowsFile({
          target: resolved,
          content: "overwrite",
          expectedVersion: { kind: "absent" },
        }),
      ).rejects.toMatchObject({ code: "filesystem_target_changed" });
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe(
        "user changed",
      );
      expect(await readdir(root)).toEqual(["note.txt"]);
    }, 15_000);

    test("a junction inserted after resolution cannot redirect reads or writes outside the authorized root", async () => {
      const { context, target, root } = await fixture();
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "sub/note.txt"), "authorized");
      const readTarget = target("sub/note.txt"),
        writeTarget = target("sub/new.txt");
      const outside = join(context.rootDir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "note.txt"), "private");
      await rename(join(root, "sub"), join(root, "held"));
      await symlink(outside, join(root, "sub"), "junction");
      await expect(
        readWindowsFileSlices(readTarget, { headBytes: 64, tailBytes: 0 }),
      ).rejects.toMatchObject({ code: "filesystem_path_changed" });
      await expect(
        writeWindowsFile({
          target: writeTarget,
          content: "escape",
          expectedVersion: { kind: "absent" },
        }),
      ).rejects.toMatchObject({ code: "filesystem_path_changed" });
      expect(await readdir(outside)).toEqual(["note.txt"]);
      expect(await readFile(join(outside, "note.txt"), "utf8")).toBe("private");
    }, 15_000);

    test.each(["bad.txt:secret", "NUL", "COM1.txt", "trailing."])(
      "rejects Windows alias/device component %s",
      async (name) => {
        const { root } = await fixture();
        const target = {
          location: "agent_work" as const,
          rootPath: root,
          absolutePath: join(root, name),
          relativePath: name,
          logicalPath: name,
        };
        await expect(
          writeWindowsFile({
            target,
            content: "blocked",
            expectedVersion: { kind: "absent" },
          }),
        ).rejects.toMatchObject({ code: "filesystem_invalid_path" });
        expect(await readdir(root)).toEqual([]);
      },
      10_000,
    );

    test("reports real ConstrainedLanguage as policy blocking before compiling or doing file work", async () => {
      const constrainedSpawn: typeof spawn = ((
        executable: string,
        args: string[],
        options: object,
      ) =>
        spawn(
          executable,
          [
            ...args.slice(0, -1),
            "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';" +
              args.at(-1),
          ],
          options,
        )) as typeof spawn;
      await expect(
        runWindowsFilesystem(
          { operation: "probe" },
          undefined,
          constrainedSpawn,
        ),
      ).rejects.toMatchObject({
        code: "filesystem_windows_policy_blocked",
        data: {
          retryable: false,
          blockedBy: "system_policy",
          operationOutcome: "not_started",
        },
      });
    }, 10_000);
  },
);
