import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, readdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { LlamaInstaller } from "./install.js";
import { ManagedLlamaService } from "./service.js";
import * as windowsStorage from "./windows-storage.js";
import type { Downloader, Release } from "./contracts.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdtemp: vi.fn(original.mkdtemp) };
});
const owned: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
type Entry = { name: string; type?: string; target?: string; data?: string };
function archive(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const h = Buffer.alloc(512);
    h.write(entry.name, 0, 100, "utf8");
    h.write("0000700\0", 100, "ascii");
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    h.fill(32, 148, 156);
    h.write(entry.type ?? "0", 156, "ascii");
    if (entry.target) h.write(entry.target, 157, 100, "utf8");
    h.write("ustar\0", 257, "ascii"); h.write("00", 263, "ascii");
    const checksum = h.reduce((sum, byte) => sum + byte, 0);
    h.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const server: Entry = { name: "bin/llama-server", data: "synthetic non-engine bytes" };
async function fixture(entries: Entry[] = [server], badDigest = false, failure = false) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "abot-llama-unit-"));
  owned.push(parent);
  const root = join(parent, "install");
  const bytes = archive(entries);
  const release: Release = { tag: "test-only", name: "synthetic.tar.gz", url: "https://example.invalid/never-fetched", size: bytes.length, sha256: badDigest ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") };
  const download = vi.fn<Downloader>(async () => (async function* () {
    yield bytes.subarray(0, 10);
    if (failure) throw new Error("synthetic download failure");
    yield bytes.subarray(10);
  })());
  return { root, release, download, installer: new LlamaInstaller(root, release, download) };
}
test("failed first download can be retried after restarting the service", async () => {
  const f = await fixture();
  f.download.mockRejectedValueOnce(new Error("offline"));
  const create = () => new ManagedLlamaService(dirname(f.root), {
    platform: { os: "darwin", arch: "arm64" },
    createInstaller: directory => new LlamaInstaller(directory, f.release, f.download),
  });
  const first = create();
  await expect(first.install()).rejects.toMatchObject({ code: "install_failed" });
  await first.close();
  const restarted = create();
  try { expect((await restarted.install()).installation).toBe("installed"); }
  finally { await restarted.close(); }
  expect(f.download).toHaveBeenCalledTimes(2);
});
test("failed staging creation can be retried after restarting the service", async () => {
  const f = await fixture();
  const create = () => new ManagedLlamaService(dirname(f.root), {
    platform: { os: "darwin", arch: "arm64" },
    createInstaller: directory => new LlamaInstaller(directory, f.release, f.download),
  });
  vi.mocked(fs.mkdtemp).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  const first = create();
  await expect(first.install()).rejects.toMatchObject({ code: "install_failed" });
  await first.close();
  expect(f.download).not.toHaveBeenCalled();
  expect(await readdir(dirname(f.root))).toEqual([]);
  const restarted = create();
  try { expect((await restarted.install()).installation).toBe("installed"); }
  finally { await restarted.close(); }
  expect(f.download).toHaveBeenCalledOnce();
});
test.each([false, true])("staging failure preserves a pre-existing root (nonempty: %s)", async nonempty => {
  const f = await fixture();
  await mkdir(f.root, { mode: 0o700 });
  if (nonempty) await writeFile(join(f.root, "keep"), "unrelated");
  vi.mocked(fs.mkdtemp).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  await expect(f.installer.install()).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await readdir(f.root)).toEqual(nonempty ? ["keep"] : []);
  expect(f.download).not.toHaveBeenCalled();
});
test("failed staging ACL claim permits a fresh-service retry even while the helper remains unavailable", async () => {
  const f = await fixture(), root = join(dirname(f.root), ".abot-managed-llama");
  const create = () => new ManagedLlamaService(dirname(f.root), {
    platform: { os: "darwin", arch: "arm64" },
    createInstaller: directory => new LlamaInstaller(directory, f.release, f.download),
  });
  let failed = false;
  vi.spyOn(windowsStorage, "verifyWindowsLlamaStorage").mockImplementation(async (path, access) => {
    if (access === "create-directory" && path !== root) failed = true;
    if (failed) throw new Error("ACL helper unavailable");
  });
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const first = create();
  await expect(first.install()).rejects.toMatchObject({ code: "install_failed" });
  await first.close();
  expect(f.download).not.toHaveBeenCalled();
  expect(await readdir(dirname(f.root))).toEqual([]);
  vi.unstubAllGlobals();
  const fresh = create();
  try { expect((await fresh.install()).installation).toBe("installed"); }
  finally { await fresh.close(); }
  expect(f.download).toHaveBeenCalledOnce();
});
test.each([false, true])("staging ACL failure preserves a pre-existing root and nonempty staging (%s)", async nonempty => {
  const f = await fixture(), failure = new Error("ACL claim failed");
  await mkdir(f.root, { mode: 0o700 });
  await writeFile(join(f.root, "keep"), "existing");
  let staging = "";
  vi.spyOn(windowsStorage, "verifyWindowsLlamaStorage").mockImplementation(async (path, access) => {
    if (access !== "create-directory") return;
    staging = path;
    if (nonempty) await writeFile(join(path, "keep"), "staging content");
    // Simulate a failure reported after ACL application: later verification passes.
    throw failure;
  });
  vi.stubGlobal("process", { ...process, platform: "win32" });
  await expect(f.installer.install()).rejects.toBe(failure);
  expect(await readFile(join(f.root, "keep"), "utf8")).toBe("existing");
  if (nonempty) expect(await readFile(join(staging, "keep"), "utf8")).toBe("staging content");
  else expect(await readdir(f.root)).toEqual(["keep"]);
  expect(f.download).not.toHaveBeenCalled();
});
test("installs synthetic POSIX ustar/gzip, reports full coverage and inspects without downloading again", async () => {
  const f = await fixture([server, { name: "bin/lib.dylib", data: "synthetic library" }, { name: "bin/lib-link.dylib", type: "2", target: "lib.dylib" }]);
  expect(await f.installer.inspect()).toBeNull();
  expect(f.download).not.toHaveBeenCalled();
  const installed = await f.installer.install();
  expect(await readFile(installed.executable, "utf8")).toBe(server.data);
  expect(installed.extraction).toMatchObject({ parsedRecords: 3, files: 2, directories: 0, symlinks: 1, coverage: "complete archive", unresolvedParsingExceptions: [] });
  console.log("Synthetic extraction coverage", installed.extraction);
  expect(await f.installer.inspect()).toEqual(installed);
  expect(await f.installer.install()).toEqual(installed);
  expect(f.download).toHaveBeenCalledOnce();
});
test("wrong digest publishes nothing and removes only owned staging", async () => {
  const f = await fixture([server], true);
  await expect(f.installer.install()).rejects.toMatchObject({ code: "invalid_installation" });
  expect(await f.installer.inspect()).toBeNull();
  expect(await readdir(dirname(f.root))).toEqual([]);
});
test("failed install preserves a pre-existing storage root and its contents", async () => {
  const f = await fixture([server], true);
  await mkdir(f.root, { mode: 0o700 });
  await writeFile(join(f.root, "keep"), "unrelated");
  await expect(f.installer.install()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual(["keep"]);
  expect(await readFile(join(f.root, "keep"), "utf8")).toBe("unrelated");
});
test("failed download publishes no partial installation", async () => {
  const f = await fixture([server], false, true);
  await expect(f.installer.install()).rejects.toThrow("synthetic download failure");
  expect(await f.installer.inspect()).toBeNull();
  expect(await readdir(dirname(f.root))).toEqual([]);
});
test.each([
  { name: "../escape", data: "bad" },
  { name: "bin/link", type: "2", target: "/outside" },
  { name: "bin/link", type: "2", target: "../../outside" },
  { name: "bin/link", type: "2", target: "link" },
  { name: "bin/link", type: "2", target: "missing" },
])("rejects unsafe archive entry %j with explicit incomplete coverage", async (entry) => {
  const f = await fixture([server, entry]);
  const error = await f.installer.install().then(() => null, error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.extraction.coverage).toBe("incomplete; extraction failed");
  expect(error.extraction.parsedRecords).toBeGreaterThanOrEqual(1);
  expect(error.extraction.unresolvedParsingExceptions.length).toBeGreaterThan(0);
  console.log("Expected rejected synthetic archive", error.extraction);
  expect(await f.installer.inspect()).toBeNull();
  expect(await readdir(dirname(f.root))).toEqual([]);
});
