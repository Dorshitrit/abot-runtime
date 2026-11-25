import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractArchive } from "./archive.js";
import { claimCreatedManagedPath } from "./host-files.js";
import { tarFixture, zipFixture } from "./__tests__/archive-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function extract(bytes: Buffer, format: "zip" | "tar.gz" = "zip") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "abot-archive-platform-"));
  roots.push(root);
  await claimCreatedManagedPath(root, true);
  const run = () => extractArchive((async function* () { yield bytes; })(), root, new AbortController().signal, format);
  return { root, run };
}
test("extracts the Windows server and its companion DLL with complete coverage", async () => {
  const f = await extract(await zipFixture());
  expect(await f.run()).toMatchObject({ executable: "llama-server.exe", files: 2, symlinks: 0, coverage: "complete archive" });
  expect(await readFile(join(f.root, "engine.dll"), "utf8")).toBe("synthetic library");
}, 60_000);
test.skipIf(process.platform === "win32")("accepts basic GNU tar while preserving POSIX ustar support", async () => {
  for (const gnu of [false, true]) {
    const f = await extract(tarFixture(gnu), "tar.gz");
    expect(await f.run()).toMatchObject({ executable: "bin/llama-server", files: 1, coverage: "complete archive" });
  }
});
test.each(["../escape.dll", "/absolute.dll", "C:/drive.dll", "name:stream.dll", "CON.dll", "a/LPT1.txt", "trailing./file", "a\\b.dll", "file?.dll", "file .dll/../x", "llama-server.exe/child"])("rejects unsafe ZIP namespace %s before writing", async name => {
  const f = await extract(await zipFixture({ "llama-server.exe": "engine", [name]: "unsafe" }));
  await expect(f.run()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
}, 20_000);
test("rejects case collisions and data/header mismatches before writing", async () => {
  const collision = await zipFixture({ "llama-server.exe": "engine", "a.dll": "a", "A.dll": "b" });
  const mismatch = await zipFixture(); mismatch.writeUInt32LE(7, 14);
  const truncated = (await zipFixture()).subarray(0, -4);
  for (const bytes of [collision, mismatch, truncated]) {
    const f = await extract(bytes);
    await expect(f.run()).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  }
}, 60_000);
test("bounds actual inflation even when ZIP sizes understate the content", async () => {
  const bytes = await zipFixture({ "llama-server.exe": "x".repeat(10000) });
  const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(1, 22); bytes.writeUInt32LE(1, directory + 24);
  const f = await extract(bytes);
  await expect(f.run()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
}, 20_000);
test("GNU sparse metadata remains unsupported even with a valid header checksum", async () => {
  const bytes = gunzipSync(tarFixture()); bytes[386] = 1;
  bytes.fill(32, 148, 156);
  bytes.write(bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  const f = await extract(gzipSync(bytes), "tar.gz");
  await expect(f.run()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
}, 20_000);
