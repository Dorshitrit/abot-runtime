import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegisteredToolPayloadTarget, RegisteredToolPayloadTargetContextError } from "../adapters/registered-tool-payload-target-read.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "payload-target-read-"));
  await fs.writeFile(join(root, "target.txt"), "exact\r\ncontent\n");
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const read = (targetPath = "target.txt") => readRegisteredToolPayloadTarget({
  targetParam: "path", targetPath, sharedState: { runtimePaths: { agentWorkDir: root } },
});

test("reads only the selected regular file and preserves exact bytes", async () => {
  await expect(read()).resolves.toBe("exact\r\ncontent\n");
  expect(fs.stat).toHaveBeenCalledExactlyOnceWith(await fs.realpath(join(root, "target.txt")));
  expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(await fs.realpath(join(root, "target.txt")), "utf8");
});

test.each(["missing", "not_file"] as const)("reports an actual %s target without invoking file reading", async reason => {
  await fs.unlink(join(root, "target.txt"));
  if (reason === "not_file") await fs.mkdir(join(root, "target.txt"));
  await expect(read()).rejects.toMatchObject({ name: "RegisteredToolPayloadTargetContextError", reason,
    code: `payload_target_context_${reason}`, targetParam: "path", targetPath: "target.txt" });
  expect(fs.readFile).not.toHaveBeenCalled();
});

test.each([
  ["EACCES", "access_denied"], ["EPERM", "access_denied"],
  ["EIO", "read_failure"], ["ENOENT", "missing"], ["ENOTDIR", "not_file"],
] as const)("preserves the %s read failure category without exposing its internal message", async (code, reason) => {
  vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error(`private filesystem detail: ${root}`), { code }));
  const failure = await read().catch(error => error);
  expect(failure).toBeInstanceOf(RegisteredToolPayloadTargetContextError);
  expect(failure).toMatchObject({ reason, code: `payload_target_context_${reason}`, targetPath: "target.txt" });
  expect(failure.message).toContain('"target.txt"');
  expect(failure.message).toContain("No external operation was executed");
  expect(failure.message).not.toContain(root);
  expect(failure.message).not.toContain("private filesystem detail");
  expect(failure).not.toHaveProperty("cause");
});

test("a denied target scope remains denied without reading outside the configured root", async () => {
  await expect(read("../outside.txt")).rejects.toMatchObject({ reason: "access_denied", targetPath: "../outside.txt" });
  expect(fs.stat).not.toHaveBeenCalled();
  expect(fs.readFile).not.toHaveBeenCalled();
});
