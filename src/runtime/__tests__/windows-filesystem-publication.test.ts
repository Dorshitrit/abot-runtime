import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readMutationSnapshot } from "../../../plugins/filesystem/source/bounded-io.js";
import { WINDOWS_FILESYSTEM_SOURCE } from "../../../plugins/filesystem/source/windows/source.js";
import { removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";
import {
  createFilesystemScriptFixture,
  runFilesystemScript,
} from "./windows-filesystem-script-fixture.js";

afterEach(removePortablePluginFixtures);

const PUBLICATION =
  "PublishLinkRelative(file, chain.Current, name, current != null);";
const CHECKPOINT = "ABOT_PUBLICATION_CHECKPOINT";
const PAUSE =
  'Console.WriteLine("' +
  CHECKPOINT +
  '"); Console.Out.Flush(); System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);';

function checkpointSource(point: string): string {
  if (point === "created")
    return WINDOWS_FILESYSTEM_SOURCE.replace(
      "WritePreparedContent(file, bytes);",
      PAUSE + " WritePreparedContent(file, bytes);",
    );
  if (point === "written")
    return WINDOWS_FILESYSTEM_SOURCE.replace(
      "WritePreparedContent(file, bytes);",
      "WritePreparedContent(file, bytes); " + PAUSE,
    );
  if (point === "prepared")
    return WINDOWS_FILESYSTEM_SOURCE.replace(
      PUBLICATION,
      PAUSE + " " + PUBLICATION,
    );
  if (point === "published")
    return WINDOWS_FILESYSTEM_SOURCE.replace(
      PUBLICATION,
      PUBLICATION + " " + PAUSE,
    );
  return WINDOWS_FILESYSTEM_SOURCE;
}

async function writeFixture(existing: boolean) {
  const { context, root } = await createFilesystemScriptFixture();
  const name = "target.txt";
  const path = join(root, name);
  if (existing) await writeFile(path, "original");
  const snapshot = await readMutationSnapshot(
    context.runtimePathResolver.resolve(name),
  );
  const expected = Object.fromEntries(
    Object.entries(snapshot.version).map(([key, value]) => [
      key,
      typeof value === "bigint" ? String(value) : value,
    ]),
  );
  return {
    root,
    name,
    path,
    request: {
      operation: "write",
      relativePath: name,
      expected,
      content: Buffer.from("replacement").toString("base64"),
    },
  };
}

describe.skipIf(process.platform !== "win32")(
  "Windows atomic file publication",
  () => {
    test.each(
      [false, true].flatMap((existing) =>
        ["created", "written", "prepared", "published", "normal"].map(
          (point) => ({ existing, point }),
        ),
      ),
    )(
      "cleans the temporary name after $point (existing: $existing)",
      async ({ existing, point }) => {
        const fixture = await writeFixture(existing);
        const result = await runFilesystemScript(
          checkpointSource(point),
          fixture.root,
          fixture.request,
          point === "normal" ? undefined : CHECKPOINT,
        );
        expect(result).toEqual(
          point === "normal"
            ? { ok: true, result: { committed: true } }
            : { interruptedAt: CHECKPOINT },
        );
        const published = point === "published" || point === "normal";
        expect(await readdir(fixture.root)).toEqual(
          existing || published ? [fixture.name] : [],
        );
        if (!existing && !published) {
          await expect(stat(fixture.path)).rejects.toMatchObject({
            code: "ENOENT",
          });
          return;
        }
        expect(await readFile(fixture.path, "utf8")).toBe(
          published ? "replacement" : "original",
        );
        expect((await stat(fixture.path)).nlink).toBe(1);
      },
      20_000,
    );

    test.each([false, true])(
      "unsupported publication leaves the destination unchanged (existing: %s)",
      async (existing) => {
        const fixture = await writeFixture(existing);
        // Simulate only the OS rejecting FileLinkInformationEx; all preparation and
        // automatic handle cleanup still execute in the actual Windows helper.
        const source = WINDOWS_FILESYSTEM_SOURCE.replace(
          "IoStatus status;\n      CheckLinkPublication(NtSetInformationFile(file, out status, buffer, (uint)(nameOffset+bytes.Length), 72));",
          "CheckLinkPublication(unchecked((int)0xC0000003));",
        );
        expect(
          await runFilesystemScript(source, fixture.root, fixture.request),
        ).toEqual({
          ok: false,
          code: "filesystem_windows_publication_unsupported",
        });
        expect(await readdir(fixture.root)).toEqual(
          existing ? [fixture.name] : [],
        );
        if (existing)
          expect(await readFile(fixture.path, "utf8")).toBe("original");
      },
      20_000,
    );
  },
);
