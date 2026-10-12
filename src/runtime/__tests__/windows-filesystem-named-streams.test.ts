import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import { removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";
import { createFilesystemScriptFixture } from "./windows-filesystem-script-fixture.js";

afterEach(removePortablePluginFixtures);

describe.skipIf(process.platform !== "win32")(
  "Windows named file streams",
  () => {
    test.each([
      ["Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\n"],
      ["application-metadata", ""],
      ["long-stream-" + "x".repeat(200), "metadata"],
    ])(
      "preserves %s and rejects both mutation tools",
      async (stream, metadata) => {
        const { context, root } = await createFilesystemScriptFixture();
        const path = join(root, "downloaded.txt");
        await writeFile(path, "original");
        await writeFile(path + ":" + stream, metadata);
        const plugin = createFilesystemPlugin(context);
        expect(
          await plugin.handlers.read_file!({ path: "downloaded.txt" }),
        ).toMatchObject({ ok: true });
        const mutations = [
          () =>
            plugin.handlers.write_file!({
              path: "downloaded.txt",
              content: "replacement",
            }),
          () =>
            plugin.handlers.edit_file!({
              path: "downloaded.txt",
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
          expect(await mutate()).toMatchObject({
            ok: false,
            errorCode: "filesystem_named_streams_unsupported",
            data: {
              retryable: false,
              blockedBy: "file_named_streams",
              targetUnchanged: true,
            },
          });
          expect(await readFile(path, "utf8")).toBe("original");
          expect(await readFile(path + ":" + stream, "utf8")).toBe(metadata);
          expect(await readdir(root)).toEqual(["downloaded.txt"]);
        }
      },
      30_000,
    );

    test("ordinary empty and nonempty files remain replaceable", async () => {
      const { context, root } = await createFilesystemScriptFixture();
      const plugin = createFilesystemPlugin(context);
      for (const [name, original] of [
        ["empty.txt", ""],
        ["ordinary.txt", "original"],
      ]) {
        await writeFile(join(root, name), original);
        expect(
          await plugin.handlers.write_file!({
            path: name,
            content: "replacement",
          }),
        ).toMatchObject({ ok: true });
        expect(await readFile(join(root, name), "utf8")).toBe("replacement");
      }
    }, 20_000);
  },
);
