import { readFile, readdir, writeFile } from "node:fs/promises";
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

// Try a real second native handle exactly after copying the destination DACL.
// The account is authorized by that DACL, so failure must come from sharing.
const ASSERT_TEMPORARY_IS_EXCLUSIVE = String.raw`
public static partial class AbotFilesystem {
  static void RejectCommit() { throw new FsFault("forced_commit_failure"); }
  static void AssertTemporaryIsExclusive(SafeFileHandle parent, string name) {
    try {
      using (var observer=OpenHandle(parent, name, false, 1, 0x80000000, 7))
        throw new FsFault("temporary_is_readable");
    } catch (FsFault error) {
      if (error.Code != "filesystem_access_denied") throw;
    }
    try {
      using (var writer=OpenHandle(parent, name, false, 1, 0x40000000, 7))
        throw new FsFault("temporary_is_writable");
    } catch (FsFault error) {
      if (error.Code != "filesystem_access_denied") throw;
    }
  }
}
`;

describe.skipIf(process.platform !== "win32")(
  "Windows precommit file access",
  () => {
    test.each([false, true])(
      "prepared content is exclusive until publication (reject commit: %s)",
      async (rejectCommit) => {
        const { context, root } = await createFilesystemScriptFixture();
        const name = "existing.txt";
        const path = join(root, name);
        await writeFile(path, "original");
        const target = context.runtimePathResolver.resolve(name);
        const snapshot = await readMutationSnapshot(target);
        const expected = Object.fromEntries(
          Object.entries(snapshot.version).map(([key, value]) => [
            key,
            typeof value === "bigint" ? String(value) : value,
          ]),
        );
        let source =
          WINDOWS_FILESYSTEM_SOURCE.replace(
            "if (current != null) PreserveAccess(current, file);",
            "if (current != null) PreserveAccess(current, file); AssertTemporaryIsExclusive(chain.Current, temporary);",
          ) + ASSERT_TEMPORARY_IS_EXCLUSIVE;
        if (rejectCommit) {
          source = source.replace(
            "PublishLinkRelative(file, chain.Current, name, current != null);",
            "RejectCommit();",
          );
        }
        const result = await runFilesystemScript(source, root, {
          operation: "write",
          relativePath: name,
          expected,
          content: Buffer.from("replacement").toString("base64"),
        });
        expect(result).toEqual(
          rejectCommit
            ? { ok: false, code: "forced_commit_failure" }
            : { ok: true, result: { committed: true } },
        );
        expect(await readFile(path, "utf8")).toBe(
          rejectCommit ? "original" : "replacement",
        );
        expect(await readdir(root)).toEqual([name]);
      },
      20_000,
    );
  },
);
