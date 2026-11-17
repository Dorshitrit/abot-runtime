import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { captureRuntimeFilesystemScope } from "../context/runtime-filesystem-scope.js";
import { parseSupervisorWorkingDirectoryOutput } from "../steps/supervisor-decision/working-directory.js";

let temp: string;
let root: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "super-directory-"));
  root = join(temp, "agent-work");
  await mkdir(root);
});
afterEach(() => rm(temp, { recursive: true, force: true }));

function select(value: unknown, scope = captureRuntimeFilesystemScope(root)) {
  const result = parseSupervisorWorkingDirectoryOutput(JSON.stringify({ workingDirectory: value }), {
    filesystemScope: scope,
  });
  return result.ok ? result.decision.workingDirectory : undefined;
}

test("an in-root absolute directory converts to its canonical portable role-call value", () => {
  expect(select(root)).toBe(".");
  expect(select(join(root, "new folder", "nested"))).toBe("new folder/nested");
  expect(select("new folder/nested")).toBe("new folder/nested");
  expect(select("./null")).toBe("null");
  expect(select(join(root, "null"))).toBe("null");
});

test("refuses absent selections, unbound absolute paths and path namespace changes", () => {
  for (const value of [null, " null ", root + "-sibling", root + sep + ".." + sep + "agent-work",
    join(root, "workspace", "in-agent-work"), "../above"]) {
    expect(select(value)).toBeUndefined();
  }
  expect(parseSupervisorWorkingDirectoryOutput(JSON.stringify({ workingDirectory: root })).ok).toBe(false);
});

test("checks physical containment through existing ancestors for new paths", async () => {
  await mkdir(join(root, "inside"));
  await mkdir(join(temp, "outside"));
  await symlink(join(temp, "outside"), join(root, "escape"), "junction");
  await symlink(join(root, "inside"), join(root, "alias"), "junction");
  expect(select(join(root, "escape", "new"))).toBeUndefined();
  expect(select(join(root, "alias", "new"))).toBe("inside/new");
});
