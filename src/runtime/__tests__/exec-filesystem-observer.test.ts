import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { captureExecFilesystemSnapshot } from "../../../plugins/exec/source/filesystem-observer.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exec-observer-"));
  temporaryRoots.push(root);
  return root;
}

describe("exec filesystem observer", () => {
  test("stops directory enumeration at the explicit entry budget", async () => {
    const root = await temporaryRoot();
    const fileCount = 4_100;
    for (let offset = 0; offset < fileCount; offset += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, fileCount - offset) }, (_, index) =>
          writeFile(
            join(root, `entry-${String(offset + index).padStart(5, "0")}`),
            "x",
          ),
        ),
      );
    }

    const snapshot = await captureExecFilesystemSnapshot(root, ".");

    expect(snapshot.entries.size).toBe(4_096);
    expect(snapshot.complete).toBe(false);
  }, 15_000);

  test("records symlinks without following or hashing their external target", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const outsideFile = join(outside, "private.txt");
    await writeFile(outsideFile, "private");
    await symlink(outsideFile, join(root, "external-link"));

    const snapshot = await captureExecFilesystemSnapshot(root, ".");

    expect(snapshot.entries.get("external-link")).toMatchObject({
      kind: "symlink",
    });
    expect(snapshot.entries.get("external-link")).not.toHaveProperty(
      "contentHash",
    );
  });
});
