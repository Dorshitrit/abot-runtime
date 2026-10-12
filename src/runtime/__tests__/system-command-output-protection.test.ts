import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemOutputCapture } from "../../computer-access/command-output-capture.js";
import { redactSecretText } from "../../computer-access/security/secret-text.js";
import type { SystemProcessResult } from "../../computer-access/contracts.js";

const storageFault = vi.hoisted(() => ({ rewrite: false, capture: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
    const sink = actual.createWriteStream(...args);
    if (storageFault.capture && String(args[0]).endsWith("stdout.bytes"))
      sink.once("pipe", () => sink.destroy(new Error("simulated capture write failure")));
    return sink;
  } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (storageFault.rewrite && String(args[0]).endsWith("stderr.bytes")) throw new Error("simulated rewrite failure");
    return actual.writeFile(...args);
  } };
});

type Capture = Awaited<ReturnType<typeof createSystemOutputCapture>>;
const cases: { root: string; output: Capture }[] = [];
const processResult: SystemProcessResult = { status: "completed", exitCode: 7,
  stdout: "", stderr: "", outputTruncated: false,
  spawnedProcess: { pid: 42, pidNamespace: "runtime_os", executable: "/safe/shell", identitySource: "spawn_arguments" } };

afterEach(async () => {
  storageFault.rewrite = false;
  storageFault.capture = false;
  for (const { root, output } of cases.splice(0)) {
    await output.finish();
    output.release();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(redact = redactSecretText) {
  const parent = join(process.cwd(), ".codex/artifacts/secret-protection-contract-20261010/protection");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  const output = await createSystemOutputCapture(root, 60_000, redact);
  cases.push({ root, output });
  const directory = join(root, (await readdir(root))[0]!);
  const stdout = new PassThrough(), stderr = new PassThrough(), failure = vi.fn();
  output.capture.attach(stdout, stderr, failure);
  async function end(stdoutTail: string | Buffer = "", stderrTail: string | Buffer = "") {
    const ended = Promise.all([once(stdout, "end"), once(stderr, "end")]);
    stdout.end(stdoutTail); stderr.end(stderrTail);
    await ended;
  }
  const stored = (stream: "stdout" | "stderr") => readFile(join(directory, stream + ".bytes"));
  return { output, directory, stdout, stderr, failure, end, stored };
}

test("private raw capture cannot be read before full checks, and late secrets are replaced before admission", async () => {
  let directory = "";
  const scanner = vi.fn((text: string) => {
    expect(readFileSync(join(directory, "stdout.bytes"), "utf8")).toContain("api_key=synthetic-secret");
    expect(readFileSync(join(directory, "stderr.bytes"), "utf8")).toBe("ordinary diagnostic");
    return redactSecretText(text);
  });
  const f = await fixture(scanner); directory = f.directory;
  f.stdout.write("ordinary prefix ".repeat(10_000));
  f.stderr.write("ordinary diagnostic");
  await vi.waitFor(async () => expect((await f.stored("stdout")).length).toBeGreaterThan(0));
  await expect(f.output.read("stdout", 0, 64)).rejects.toThrow("system_output_unavailable");
  await f.end("api_key=synthetic-secret");
  const finishing = f.output.finish(processResult, false);
  expect(f.output.finish(processResult, false)).toBe(finishing);
  await expect(f.output.read("stdout", 0, 64)).rejects.toThrow("system_output_unavailable");
  await finishing;
  expect(await f.stored("stdout")).toEqual(Buffer.from("[REDACTED]"));
  expect(await f.stored("stderr")).toEqual(Buffer.from("ordinary diagnostic"));
  expect(f.output.receipt).toMatchObject({ complete: true, stdoutBytes: 10,
    stdoutSha256: createHash("sha256").update("[REDACTED]").digest("hex") });
  expect(await f.output.read("stdout", 0, 64)).toEqual(Buffer.from("[REDACTED]"));
  expect(f.failure).not.toHaveBeenCalled();
});

test("UTF-8 and credential labels split across pipe chunks are inspected as complete fields", async () => {
  const f = await fixture();
  for (const byte of Buffer.from("שלום 🚀 api_key=synthetic-secret")) f.stdout.write(Buffer.from([byte]));
  for (const byte of Buffer.from("diagnostic\r\nשלום 🚀")) f.stderr.write(Buffer.from([byte]));
  await f.end();
  expect(await f.output.finish(processResult)).toEqual({ stdout: "[REDACTED]", stderr: "diagnostic\r\nשלום 🚀" });
});

test.each(["scanner", "utf8", "utf8_stderr", "partial_stdout", "partial_stderr"])("%s failure purges both raw streams without admitting either", async mode => {
  const scanner = mode === "scanner" ? (text: string) => {
    if (text === "unreleased diagnostic") throw new Error("api_key=synthetic-error");
    return text;
  } : redactSecretText;
  const f = await fixture(scanner);
  f.stdout.write("unreleased content"); f.stderr.write("unreleased diagnostic");
  if (mode === "partial_stdout") {
    const ended = once(f.stderr, "end"); f.stderr.end(); await ended;
  } else if (mode === "partial_stderr") {
    const ended = once(f.stdout, "end"); f.stdout.end(); await ended;
  } else await f.end(mode === "utf8" ? Buffer.from([0xc3]) : "", mode === "utf8_stderr" ? Buffer.from([0xc3]) : "");
  expect(await f.output.finish({ ...processResult, status: "aborted", exitCode: null })).toEqual({ stdout: "", stderr: "" });
  expect(f.output.failureKind).toBe("security");
  expect(f.output.receipt).toMatchObject({ complete: false, stdoutBytes: 0, stderrBytes: 0 });
  await expect(f.stored("stdout")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.stored("stderr")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.directory, "receipt.json"), "utf8")).not.toContain("synthetic-error");
  expect(f.output.processResult).toMatchObject({ status: "aborted", exitCode: null, spawnedProcess: { pid: 42 } });
  await expect(f.output.read("stdout", 0, 1)).rejects.toThrow("system_output_unavailable");
  expect(f.failure).not.toHaveBeenCalled();
});

test("process identity is checked before a receipt is written and command status remains exact", async () => {
  const f = await fixture();
  await f.end("ordinary");
  await f.output.finish({ ...processResult, spawnedProcess: { ...processResult.spawnedProcess!, executable: "/path/api_key=synthetic-secret" } });
  const saved = JSON.parse(await readFile(join(f.directory, "receipt.json"), "utf8"));
  expect(saved).toMatchObject({ processStatus: "completed", exitCode: 7,
    spawnedProcess: { executable: "[REDACTED]", pid: 42, pidNamespace: "runtime_os", identitySource: "spawn_arguments" } });
  expect(JSON.stringify(saved)).not.toContain("synthetic-secret");
  expect(f.output.processResult?.spawnedProcess?.executable).toBe("[REDACTED]");
});

test("capture preserves exact large output without introducing a fixed 16 MiB rejection", async () => {
  const f = await fixture(text => text);
  const chunk = "ordinary ".repeat(131_072);
  for (let index = 0; index < 16; index += 1) f.stdout.write(chunk);
  await f.end("tail", "\ufeffdiagnostic\r\n");
  const delivered = await f.output.finish(processResult);
  expect(delivered.stdout).toBe(chunk.repeat(16) + "tail");
  expect(delivered.stderr).toBe("\ufeffdiagnostic\r\n");
  expect(f.output.receipt).toMatchObject({ complete: true, stdoutBytes: Buffer.byteLength(delivered.stdout) });
});

test("a completed capture never accepts a path-shaped stream reference", async () => {
  const f = await fixture(); await f.end("safe"); await f.output.finish(processResult);
  await expect(f.output.read("../receipt" as "stdout", 0, 100)).rejects.toThrow("system_output_reference_invalid");
});

test("a protected-file replacement failure purges both private sources and preserves the process receipt", async () => {
  const f = await fixture();
  await f.end("api_key=synthetic-out", "password=synthetic-err");
  storageFault.rewrite = true;
  expect(await f.output.finish(processResult)).toEqual({ stdout: "", stderr: "" });
  expect(f.output.failureKind).toBe("storage");
  expect(f.output.receipt).toMatchObject({ complete: false, stdoutBytes: 0, stderrBytes: 0 });
  await expect(f.stored("stdout")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.stored("stderr")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.output.read("stderr", 0, 100)).rejects.toThrow("system_output_unavailable");
  const receipt = await readFile(join(f.directory, "receipt.json"), "utf8");
  expect(JSON.parse(receipt)).toMatchObject({ processStatus: "completed", exitCode: 7, spawnedProcess: { pid: 42 } });
  expect(receipt).not.toContain("synthetic-");
});

test("a capture write failure stays a storage failure when it interrupts stream completion", async () => {
  storageFault.capture = true;
  const f = await fixture();
  await vi.waitFor(() => expect(f.failure).toHaveBeenCalled());
  expect(await f.output.finish({ ...processResult, status: "output_failed", exitCode: null })).toEqual({ stdout: "", stderr: "" });
  expect(f.output.failure).toBe("write_failed");
  expect(f.output.failureKind).toBe("storage");
  expect(f.output.processResult).toMatchObject({ status: "output_failed", spawnedProcess: { pid: 42 } });
  await expect(f.stored("stdout")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.stored("stderr")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.output.read("stdout", 0, 1)).rejects.toThrow("system_output_unavailable");
});
