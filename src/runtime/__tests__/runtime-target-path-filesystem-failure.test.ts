import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeToolPathResolver,
  resolveRuntimeTargetPath,
  RuntimeToolPathError,
} from "../capabilities/runtime-target-path.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), lstatSync: vi.fn(actual.lstatSync) };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "target-path-filesystem-failure-"));
  await writeFile(join(root, "target.txt"), "existing content");
});
afterEach(async () => {
  vi.resetAllMocks();
  await rm(root, { recursive: true, force: true });
});

test.each([
  ["EACCES", "EACCES", "canonicalization_failed", "access_denied"],
  ["EPERM", "EPERM", "canonicalization_failed", "access_denied"],
  ["EIO", "EACCES", "canonicalization_failed", "access_denied"],
  ["EACCES", "EIO", "canonicalization_failed", "access_denied"],
  ["EPERM", undefined, "symlink_escape", "access_denied"],
  ["EIO", "EIO", "canonicalization_failed", undefined],
  ["EIO", undefined, "symlink_escape", undefined],
] as const)(
  "realpath %s and lstat %s preserve the exact filesystem category through both path APIs",
  (realpathCode, lstatCode, reason, filesystemFailure) => {
    const roots = { agentWorkDir: root };
    const resolver = createRuntimeToolPathResolver(roots);
    const variants = [
      { resolve: () => resolver.resolve("target.txt"), message: `runtime_tool_path_${reason}` },
      { resolve: () => resolveRuntimeTargetPath("target.txt", { runtimePaths: roots }), message: `runtime_target_path_${reason}` },
    ];
    for (const variant of variants) {
      vi.mocked(fs.realpathSync).mockImplementationOnce(() => { throw filesystemError(realpathCode); });
      if (lstatCode !== undefined)
        vi.mocked(fs.lstatSync).mockImplementationOnce(() => { throw filesystemError(lstatCode); });
      const error = captureFailure(variant.resolve);
      expect(error).toBeInstanceOf(RuntimeToolPathError);
      expect(error).toMatchObject({ code: `runtime_tool_path_${reason}`, message: variant.message });
      expect(error.filesystemFailure).toBe(filesystemFailure);
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain(root);
      expect(error.message).not.toContain("private filesystem detail");
    }
  },
);

test("out-of-root targets remain policy rejections without probing filesystem permissions", () => {
  const error = captureFailure(() => resolveRuntimeTargetPath("../outside.txt", {
    runtimePaths: { agentWorkDir: root },
  }));
  expect(error.code).toBe("runtime_tool_path_outside_configured_roots");
  expect(error.filesystemFailure).toBeUndefined();
  expect(fs.realpathSync).not.toHaveBeenCalled();
  expect(fs.lstatSync).not.toHaveBeenCalled();
});

function filesystemError(code: string): Error {
  return Object.assign(new Error(`private filesystem detail: ${root}`), { code });
}

function captureFailure(resolveTarget: () => unknown): RuntimeToolPathError {
  try { resolveTarget(); }
  catch (error) {
    if (error instanceof RuntimeToolPathError) return error;
    throw error;
  }
  throw new Error("Expected path resolution to fail");
}
