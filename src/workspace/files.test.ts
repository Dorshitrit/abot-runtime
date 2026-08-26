import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  buildDeterministicWorkspaceConcat,
  buildWorkspaceSourceHash,
  readWorkspaceMarkdownFiles,
} from "./files.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-runtime-workspace-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("workspace files", () => {
  test("reads markdown in deterministic order", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "workspace", "z"), { recursive: true });
    await mkdir(join(root, "workspace", "a"), { recursive: true });
    await writeFile(join(root, "workspace", "b.md"), "B");
    await writeFile(join(root, "workspace", "a", "a.md"), "A");
    await writeFile(join(root, "workspace", "z", "z.md"), "Z");
    await writeFile(join(root, "workspace", "ignore.txt"), "X");

    const files = await readWorkspaceMarkdownFiles(join(root, "workspace"));
    expect(files.map((f) => f.path)).toEqual(["a/a.md", "b.md", "z/z.md"]);
  });

  test("hash and concat are deterministic for same inputs", () => {
    const files = [
      { path: "a.md", content: "alpha" },
      { path: "b.md", content: "beta" },
    ];
    const hash1 = buildWorkspaceSourceHash(files);
    const hash2 = buildWorkspaceSourceHash(files);
    expect(hash1).toBe(hash2);

    const text = buildDeterministicWorkspaceConcat(files);
    expect(text).toContain("### FILE: a.md");
    expect(text).toContain("### FILE: b.md");
  });
});
