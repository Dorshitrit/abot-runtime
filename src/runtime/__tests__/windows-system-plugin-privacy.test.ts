import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemOutputCapture } from "../../computer-access/command-output-capture.js";
import { redactSecretText } from "../../../plugins/system/source/security/secret-text.js";
import { createLocalSystemCommandOutput } from "../../../plugins/system/source/local-command-output.js";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";
import { verifyWindowsPrivateAccess } from "../local-host/windows-private-access.js";
import { assertWindowsPrivateFile } from "./support/windows-file-privacy.js";
import { ensureWindowsOutputDirectory } from "../../../plugins/system/source/security/windows-output-directory.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/windows-public-plugins/system-privacy");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-")); roots.push(root); return root;
}

test("capture files are private before unchecked streams arrive and remain private after protection", async () => {
  const root = join(await fixture(), "command-output");
  await ensureWindowsOutputDirectory(root);
  const output = await createSystemOutputCapture(root, 60_000, redactSecretText);
  const directory = join(root, (await readdir(root))[0]!);
  const stdout = new PassThrough(), stderr = new PassThrough();
  output.capture.attach(stdout, stderr, () => { throw new Error("unexpected capture failure"); });
  try {
    await expect(output.read("stdout", 0, 1)).rejects.toThrow("system_output_unavailable");
    if (process.platform === "win32") {
      await verifyWindowsPrivateAccess(root);
      await assertWindowsPrivateFile(join(directory, "stdout.bytes"));
      await assertWindowsPrivateFile(join(directory, "stderr.bytes"));
    } else {
      expect((await stat(directory)).mode & 0o077).toBe(0);
      expect((await stat(join(directory, "stdout.bytes"))).mode & 0o077).toBe(0);
    }
    const ended = Promise.all([once(stdout, "end"), once(stderr, "end")]);
    stdout.end("api_key=synthetic-private-fixture"); stderr.end("ordinary diagnostic");
    await ended;
    expect(await output.finish({ status: "completed", exitCode: 0, stdout: "", stderr: "", outputTruncated: false }))
      .toEqual({ stdout: "[REDACTED]", stderr: "ordinary diagnostic" });
    expect(await readFile(join(directory, "stdout.bytes"), "utf8")).toBe("[REDACTED]");
    if (process.platform === "win32") {
      await assertWindowsPrivateFile(join(directory, "stdout.bytes"));
      await assertWindowsPrivateFile(join(directory, "receipt.json"));
    }
  } finally { await output.finish(); }
}, 30_000);

test("inaccessible capture storage fails before the command can create its dispatch marker", async () => {
  const root = await fixture();
  await writeFile(join(root, "command-output"), "occupied fixture");
  const marker = join(root, "dispatched");
  const output = createLocalSystemCommandOutput({ stateDir: root, config: {} } as RuntimePluginLoadContext)();
  await expect(output.run({ executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'dispatched')", marker] }))
    .rejects.toMatchObject({ code: "system_output_storage_failed" });
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);


test.skipIf(process.platform !== "win32")("an existing broad DACL is rejected without repair or command dispatch", async () => {
  const root = await fixture();
  const directory = join(root, "command-output");
  await ensureWindowsOutputDirectory(directory);
  const execute = promisify(execFile);
  await execute("icacls.exe", [directory, "/grant", "*S-1-5-32-545:(OI)(CI)RX"], { windowsHide: true, timeout: 10_000 });
  const before = await execute("icacls.exe", [directory], { windowsHide: true, timeout: 10_000 });
  const marker = join(root, "dispatched");
  const output = createLocalSystemCommandOutput({ stateDir: root, config: {} } as RuntimePluginLoadContext)();
  await expect(output.run({ executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'dispatched')", marker] }))
    .rejects.toMatchObject({ code: "system_output_storage_failed" });
  const after = await execute("icacls.exe", [directory], { windowsHide: true, timeout: 10_000 });
  expect(after.stdout).toBe(before.stdout);
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(directory)).toEqual([]);
}, 30_000);


test.skipIf(process.platform !== "win32")("a junction cannot redirect the private output root", async () => {
  const root = await fixture();
  const destination = join(root, "elsewhere");
  await mkdir(destination);
  const directory = join(root, "command-output");
  await symlink(destination, directory, "junction");
  await expect(ensureWindowsOutputDirectory(directory)).rejects.toMatchObject({ code: "system_output_storage_failed" });
  expect(await readdir(destination)).toEqual([]);
}, 30_000);


test.skipIf(process.platform !== "win32")("plugin initialization never cleans captures through a rejected output-root junction", async () => {
  const root = await fixture();
  const destination = join(root, "elsewhere");
  const retained = join(destination, "550e8400-e29b-41d4-a716-446655440000");
  await mkdir(retained, { recursive: true });
  const marker = join(retained, "stdout.bytes");
  await writeFile(marker, "fixture retained output");
  const past = new Date(Date.now() - 60_000);
  await utimes(marker, past, past); await utimes(retained, past, past);
  await symlink(destination, join(root, "command-output"), "junction");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  createLocalSystemCommandOutput({ stateDir: root, config: { outputRetentionMs: 1 } } as unknown as RuntimePluginLoadContext);
  await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
    "SYSTEM output cleanup skipped because private storage could not be verified.",
    { code: "SYSTEM_OUTPUT_PRIVATE_STORAGE_UNAVAILABLE" }), { timeout: 15_000 });
  expect(await readFile(marker, "utf8")).toBe("fixture retained output");
}, 30_000);
