import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import { readMutationSnapshot } from "../../../plugins/filesystem/source/bounded-io.js";
import { WINDOWS_FILESYSTEM_SOURCE } from "../../../plugins/filesystem/source/windows/source.js";
import { removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";
import {
  createFilesystemScriptFixture,
  runFilesystemScript,
} from "./windows-filesystem-script-fixture.js";

const execute = promisify(execFile);
afterEach(removePortablePluginFixtures);

describe.skipIf(process.platform !== "win32")(
  "Windows file storage attributes",
  () => {
    test("NTFS-compressed files remain readable, reject both edits, and do not block ordinary files", async () => {
      const { context, root } = await createFilesystemScriptFixture();
      const path = join(root, "compressed.txt");
      const original = "original content\n".repeat(512);
      await writeFile(path, original);
      await execute("compact.exe", ["/C", "/F", "/Q", path], {
        windowsHide: true,
        timeout: 10_000,
      });
      const attributes = async () => {
        const { stdout } = await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[int][IO.File]::GetAttributes($env:ABOT_TEST_STORAGE_PATH)",
          ],
          {
            env: { ...process.env, ABOT_TEST_STORAGE_PATH: path },
            windowsHide: true,
            timeout: 10_000,
          },
        );
        return Number(stdout.trim());
      };
      expect((await attributes()) & 0x800).toBe(0x800);
      const plugin = createFilesystemPlugin(context);
      expect(
        await plugin.handlers.read_file!({ path: "compressed.txt" }),
      ).toMatchObject({ ok: true });
      const mutations = [
        () =>
          plugin.handlers.write_file!({
            path: "compressed.txt",
            content: "replacement",
          }),
        () =>
          plugin.handlers.edit_file!({
            path: "compressed.txt",
            instruction: "Replace line one",
            selection: JSON.stringify({
              placement: "replace",
              start_line: 1,
              end_line: 1,
            }),
            content: "replacement",
          }),
      ];
      for (const mutate of mutations) {
        const result = await mutate();
        expect(result).toMatchObject({
          ok: false,
          errorCode: "filesystem_storage_attributes_unsupported",
          data: {
            retryable: false,
            blockedBy: "file_storage_attributes",
            targetUnchanged: true,
          },
        });
        expect(result.output.length).toBeGreaterThan(0);
        expect(await readFile(path, "utf8")).toBe(original);
        expect((await attributes()) & 0x800).toBe(0x800);
        expect(await readdir(root)).toEqual(["compressed.txt"]);
      }
      expect(
        await plugin.handlers.write_file!({
          path: "ordinary.txt",
          content: "new content",
        }),
      ).toMatchObject({ ok: true });
    }, 30_000);

    // Inject only the OS attribute observation. This exercises the actual native
    // guard without creating an EFS certificate in the developer's Windows account.
    test.each([
      [0x4000, 1],
      [0x4000, 2],
      [0x800, 2],
    ])(
      "rejects attribute %i at observation %i and removes unpublished content",
      async (attribute, at) => {
        const { context, root } = await createFilesystemScriptFixture();
        const path = join(root, "existing.txt");
        await writeFile(path, "original");
        const snapshot = await readMutationSnapshot(
          context.runtimePathResolver.resolve("existing.txt"),
        );
        const expected = Object.fromEntries(
          Object.entries(snapshot.version).map(([key, value]) => [
            key,
            typeof value === "bigint" ? String(value) : value,
          ]),
        );
        const injection = [
          "public static partial class AbotFilesystem {",
          " static int storageObservations;",
          " static uint ObservedStorageAttributes(SafeFileHandle file) {",
          "  uint attributes=Basic(file).Attributes;",
          "  if (++storageObservations == " +
            at +
            ") return attributes | " +
            attribute +
            "u;",
          "  return attributes;",
          " }",
          "}",
        ].join("\n");
        const source =
          WINDOWS_FILESYSTEM_SOURCE.replace(
            "(Basic(file).Attributes & (encrypted | compressed))",
            "(ObservedStorageAttributes(file) & (encrypted | compressed))",
          ) + injection;
        expect(
          await runFilesystemScript(source, root, {
            operation: "write",
            relativePath: "existing.txt",
            expected,
            content: Buffer.from("replacement").toString("base64"),
          }),
        ).toEqual({
          ok: false,
          code: "filesystem_storage_attributes_unsupported",
        });
        expect(await readFile(path, "utf8")).toBe("original");
        expect(await readdir(root)).toEqual(["existing.txt"]);
      },
      20_000,
    );
  },
);
