import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { runWindowsBoundedRead } from "../../plugin-sdk/files-windows/process.js";
import { decodeWindowsReadResult } from "../../plugin-sdk/files-windows/result.js";

function response(body: string): typeof spawn {
  return ((_file: string, _args: string[], options: object) =>
    spawn(process.execPath, ["-e", body], options)) as typeof spawn;
}

describe("Windows SDK read transport", () => {
  test.each(["filesystem_windows_helper_unavailable", "filesystem_windows_policy_blocked"])(
    "maps %s to the existing SDK unavailable reason", async (code) => {
      const raw = await runWindowsBoundedRead({}, 64, undefined, response(
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" +
        JSON.stringify(JSON.stringify({ ok: false, code })) + "));",
      ));
      expect(decodeWindowsReadResult(raw, 64)).toEqual({ ok: false, reason: "safe_open_unsupported" });
    },
  );

  test("missing PowerShell is explicitly unavailable", async () => {
    const missing: typeof spawn = ((_file: string, _args: string[], options: object) =>
      spawn(process.execPath + ".absent", [], options)) as typeof spawn;
    const raw = await runWindowsBoundedRead({}, 64, undefined, missing);
    expect(decodeWindowsReadResult(raw, 64)).toEqual({ ok: false, reason: "safe_open_unsupported" });
  });

  test("abort terminates the single helper and rejects without retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    const children: ChildProcess[] = [];
    const held: typeof spawn = ((_file: string, _args: string[], options: object) => {
      calls += 1;
      const child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], options);
      children.push(child);
      child.once("spawn", () => controller.abort());
      return child;
    }) as typeof spawn;
    await expect(runWindowsBoundedRead({}, 64, controller.signal, held))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    expect(children[0]?.signalCode ?? children[0]?.exitCode).not.toBeNull();
  });

  test("the bounded deadline stops a held helper without retry", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const held: typeof spawn = ((_file: string, _args: string[], options: object) => {
      calls += 1;
      const child = spawn(process.execPath,
        ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], options);
      child.once("spawn", () => { void vi.advanceTimersByTimeAsync(15_000); });
      return child;
    }) as typeof spawn;
    try {
      await expect(runWindowsBoundedRead({}, 64, undefined, held))
        .rejects.toMatchObject({ code: "ETIMEDOUT" });
      expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("bounds response bytes and suppresses native diagnostics", async () => {
    await expect(runWindowsBoundedRead({}, 0, undefined, response(
      "process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('PRIVATE'); process.stdout.write('x'.repeat(10000)); });",
    ))).rejects.toMatchObject({ code: "EOVERFLOW" });
    const raw = await runWindowsBoundedRead({}, 64, undefined, response(
      "process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('PRIVATE'); process.stdout.write('invalid'); });",
    ));
    expect(() => decodeWindowsReadResult(raw, 64)).toThrow("EIO");
    expect(() => decodeWindowsReadResult(raw, 64)).not.toThrow("PRIVATE");
  });

  test.each([
    { ok: true, bytes: "YQ==", byteCount: 65 },
    { ok: true, bytes: "YQ==", byteCount: 2 },
    { ok: true, bytes: "!!!!", byteCount: 1 },
    { ok: false, reason: "too_large", byteCount: -1 },
    { ok: false, reason: "unknown" },
  ])("rejects malformed helper evidence %j", (value) => {
    expect(() => decodeWindowsReadResult(JSON.stringify(value), 64)).toThrow("EIO");
  });

  test("ordinary OS errors remain explicit", () => {
    expect(() => decodeWindowsReadResult('{"ok":false,"code":"file_not_found"}', 64))
      .toThrow("ENOENT");
    expect(() => decodeWindowsReadResult('{"ok":false,"code":"filesystem_access_denied"}', 64))
      .toThrow("EACCES");
  });
});
