import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CompanionCommandOutput } from "../../computer-access/companion/command-output.js";
import { readSystemOutputTransfer, SYSTEM_OUTPUT_CHUNK_BYTES } from "../../computer-access/companion/command-output-protocol.js";
import { activeSystemCaptures } from "../../computer-access/command-output-retention.js";

const failures = vi.hoisted(() => ({ receiptWrite: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (failures.receiptWrite && String(args[0]).endsWith("receipt.tmp")) throw new Error("simulated disk full");
    return actual.writeFile(...args);
  } };
});
const roots: string[] = [];
const connections: CompanionCommandOutput[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const connection of connections.splice(0)) connection.close();
  failures.receiptWrite = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/companion-output-review-20261006/capture");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const connection = new CompanionCommandOutput(root); connections.push(connection);
  const controller = new AbortController(); controllers.push(controller);
  const handlers = connection.handlers();
  const command = async (script: string) => {
    const path = join(root, "command.cjs");
    await writeFile(path, script);
    return handlers.system_command_capture!({ target: "linux", cwd: root,
      command: `'${process.execPath}' '${path}'`, outputRetentionMs: 30 * 86_400_000 }, { abortSignal: controller.signal });
  };
  return { root, connection, controller, handlers, command };
}

test.runIf(process.platform === "linux")("native output is durable before the receipt and read access stays bound to its connection", async () => {
  const f = await fixture();
  const stdout = "שלום 🚀\n".repeat(25_000), stderr = "diagnostic";
  const result = await f.command(`process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`);
  expect(result).toMatchObject({ ok: true, stdout: "", stderr: "", data: { outputCapture: { complete: true, retentionMs: 30 * 86_400_000 } } });
  const transfer = readSystemOutputTransfer(result.data!.outputTransfer);
  const directory = join(f.root, "command-output", transfer.id);
  const bytes = await readFile(join(directory, "stdout.bytes"));
  expect(bytes).toEqual(Buffer.from(stdout));
  expect(transfer.stdoutSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(transfer.stderrSha256).toBe(createHash("sha256").update(stderr).digest("hex"));
  expect(JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"))).toMatchObject({ complete: true, stdoutBytes: bytes.length });
  expect(activeSystemCaptures.has(directory)).toBe(true);
  expect(f.connection.hasTransfers()).toBe(true);
  const read = { captureId: transfer.id, stream: "stdout", offset: 0 };
  const first = await f.handlers.system_command_output!(read);
  expect(Buffer.from(first.data!.bytes as string, "base64")).toEqual(bytes.subarray(0, SYSTEM_OUTPUT_CHUNK_BYTES));
  const stranger = new CompanionCommandOutput(f.root); connections.push(stranger);
  expect(await stranger.handlers().system_command_output!(read)).toMatchObject({ ok: false, errorCode: "system_output_unavailable" });
  for (const invalid of [{ captureId: "../receipt.json" }, { captureId: randomUUID() }, { stream: "file" }, { offset: -1 }, { offset: bytes.length + 1 }]) {
    expect(await f.handlers.system_command_output!({ ...read, ...invalid })).toMatchObject({ ok: false });
  }
  expect(await f.handlers.system_command_output_close!({ captureId: transfer.id })).toMatchObject({ ok: true });
  expect(await f.handlers.system_command_output_close!({ captureId: transfer.id })).toMatchObject({ ok: true });
  expect(f.connection.hasTransfers()).toBe(false);
  expect(activeSystemCaptures.has(directory)).toBe(false);
  expect(await f.handlers.system_command_output!(read)).toMatchObject({ errorCode: "system_output_unavailable" });
  expect(await readFile(join(directory, "stdout.bytes"))).toEqual(bytes);
});

test.runIf(process.platform === "linux")("disconnect releases completed transfers and keeps their disk output", async () => {
  const f = await fixture();
  const result = await f.command('process.stdout.write("saved");');
  const transfer = readSystemOutputTransfer(result.data!.outputTransfer);
  const directory = join(f.root, "command-output", transfer.id);
  f.connection.close();
  expect(f.connection.hasTransfers()).toBe(false);
  expect(activeSystemCaptures.has(directory)).toBe(false);
  expect(await readFile(join(directory, "stdout.bytes"), "utf8")).toBe("saved");
  expect(await f.handlers.system_command_capture!({})).toMatchObject({ errorCode: "system_output_closed" });
});

test.runIf(process.platform === "linux")("storage preparation failure does not dispatch the command", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "command-output"), "blocked directory");
  const result = await f.command('require("fs").writeFileSync("executed", "yes");');
  expect(result).toMatchObject({ ok: false, errorCode: "system_output_storage_failed" });
  expect(await readdir(f.root)).not.toContain("executed");
  expect(f.connection.hasTransfers()).toBe(false);
});

test.runIf(process.platform === "linux")("failure to save the final receipt preserves process identity and the captured bytes", async () => {
  const f = await fixture();
  failures.receiptWrite = true;
  const result = await f.command('require("fs").writeFileSync("executed", "yes"); process.stdout.write("saved evidence");');
  expect(result).toMatchObject({ ok: false, exitCode: 0, errorCode: "system_output_storage_failed",
    data: { processStatus: "completed", spawnedProcess: { pid: expect.any(Number) }, outputCapture: { complete: false }, storageFailure: "receipt_write_failed" } });
  expect(await readFile(join(f.root, "executed"), "utf8")).toBe("yes");
  const capture = result.data!.outputCapture as { id: string };
  const directory = join(f.root, "command-output", capture.id);
  expect(await readFile(join(directory, "stdout.bytes"), "utf8")).toBe("saved evidence");
  expect(activeSystemCaptures.has(directory)).toBe(false);
  expect(f.connection.hasTransfers()).toBe(false);
});

test.runIf(process.platform === "linux").each(["cancel", "disconnect"])("%s during execution settles the receipt without pinning an unreachable transfer", async action => {
  const f = await fixture();
  const pending = f.command('require("fs").writeFileSync("started", "yes"); process.stdout.write("partial"); setInterval(() => {}, 1000);');
  try {
    await vi.waitFor(async () => expect(await readdir(f.root)).toContain("started"), { timeout: 2_000 });
    if (action === "disconnect") f.connection.close();
    f.controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorCode: "system_aborted", data: { processStatus: "aborted", spawnedProcess: { pid: expect.any(Number) } } });
    expect(result.data).not.toHaveProperty("outputTransfer");
    expect(f.connection.hasTransfers()).toBe(false);
    const capture = result.data!.outputCapture as { id: string };
    expect(activeSystemCaptures.has(join(f.root, "command-output", capture.id))).toBe(false);
  } finally { f.controller.abort(); await pending; }
});
