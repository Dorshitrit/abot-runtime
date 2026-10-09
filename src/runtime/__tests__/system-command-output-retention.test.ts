import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemOutputCapture } from "../../computer-access/command-output-capture.js";
import { cleanupSystemOutput, DEFAULT_SYSTEM_OUTPUT_RETENTION_MS } from "../../computer-access/command-output-retention.js";
import { CompanionCommandOutput } from "../../computer-access/companion/command-output.js";

const DAY = 86_400_000;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/companion-output-review-20261006/retention");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  return root;
}
async function age(directory: string, days: number) {
  const date = new Date(Date.now() - days * DAY);
  for (const file of await readdir(directory)) await utimes(join(directory, file), date, date);
  await utimes(directory, date, date);
}
async function savedCapture(root: string, retentionMs: number, days: number) {
  const id = randomUUID();
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "stdout.bytes"), "retained evidence");
  await writeFile(join(directory, "receipt.json"), JSON.stringify({
    kind: "system_command_output_v1", id, retentionMs, complete: true,
    completedAt: new Date(Date.now() - days * DAY).toISOString(), stdoutBytes: 17, stderrBytes: 0,
  }));
  await age(directory, days);
  return { id, directory };
}

test("reconnect keeps each capture's configured retention instead of resetting it to seven days", async () => {
  const state = await fixture();
  const root = join(state, "command-output");
  const long = await savedCapture(root, 30 * DAY, 8);
  const short = await savedCapture(root, DAY, 2);
  const connection = new CompanionCommandOutput(state);
  try {
    await vi.waitFor(async () => expect(await readdir(root)).not.toContain(short.id), { timeout: 2_000 });
    expect(await readFile(join(long.directory, "stdout.bytes"), "utf8")).toBe("retained evidence");
  } finally { connection.close(); }
});

test("a new command's policy does not shorten an earlier capture's lifetime", async () => {
  const root = await fixture();
  const saved = await savedCapture(root, 30 * DAY, 8);
  expect(await cleanupSystemOutput(root, DAY)).toBe(0);
  expect(await readdir(root)).toContain(saved.id);
});

test("captured streams and retention survive completion while an active transfer remains protected", async () => {
  const root = await fixture();
  const output = await createSystemOutputCapture(root, 2 * DAY);
  output.retain();
  try {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const failed = vi.fn();
    output.capture.attach(stdout, stderr, failed);
    stdout.end("שלום 🚀"); stderr.end("diagnostic");
    await Promise.all([new Promise<void>(resolve => stdout.once("end", resolve)),
      new Promise<void>(resolve => stderr.once("end", resolve))]);
    await output.finish(undefined, false);
    const directory = join(root, output.receipt!.id);
    expect(JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"))).toMatchObject({ retentionMs: 2 * DAY, complete: true });
    expect(await output.read("stdout", 0, 100)).toEqual(Buffer.from("שלום 🚀"));
    await age(directory, 3);
    expect(await cleanupSystemOutput(root, DEFAULT_SYSTEM_OUTPUT_RETENTION_MS)).toBe(0);
    output.release();
    expect(await cleanupSystemOutput(root, DEFAULT_SYSTEM_OUTPUT_RETENTION_MS)).toBe(1);
    expect(failed).not.toHaveBeenCalled();
  } finally { output.release(); }
});

test("incomplete captures use the cleanup fallback and unrelated files are preserved", async () => {
  const root = await fixture();
  const orphan = join(root, randomUUID());
  await mkdir(orphan);
  await writeFile(join(orphan, "stdout.bytes"), "partial");
  await age(orphan, 8);
  await writeFile(join(root, "unrelated.txt"), "keep");
  expect(await cleanupSystemOutput(root, DEFAULT_SYSTEM_OUTPUT_RETENTION_MS)).toBe(1);
  expect(await readdir(root)).toEqual(["unrelated.txt"]);
});
