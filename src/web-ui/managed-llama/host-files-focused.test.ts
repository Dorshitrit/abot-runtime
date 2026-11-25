import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, realpath, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManagedFile, createPrivateManagedDirectory } from "./host-files.js";
import { verifyWindowsLlamaStorage } from "./windows-storage.js";
vi.mock("./windows-storage.js", () => ({ verifyWindowsLlamaStorage: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "abot-storage-failure-"));
  roots.push(root);
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.mocked(verifyWindowsLlamaStorage).mockRejectedValue(new Error("ACL helper blocked"));
  return root;
}
test("failed private-directory setup removes only its new empty directory", async () => {
  const root = await fixture();
  await expect(createPrivateManagedDirectory(join(root, "new"))).rejects.toThrow("ACL helper blocked");
  expect(await readdir(root)).toEqual([]);
});
test("failed private-file setup does not strand a lock or incomplete state file", async () => {
  const root = await fixture();
  await expect(createManagedFile(join(root, "launch-state.lock"))).rejects.toThrow("ACL helper blocked");
  expect(await readdir(root)).toEqual([]);
});
test("privacy failures never remove pre-existing directories or files", async () => {
  const root = await fixture(), directory = join(root, "existing"), file = join(root, "keep");
  await mkdir(directory); await writeFile(file, "existing");
  await expect(createPrivateManagedDirectory(directory)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(createManagedFile(file)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(file, "utf8")).toBe("existing");
  expect((await readdir(root)).sort()).toEqual(["existing", "keep"]);
});
