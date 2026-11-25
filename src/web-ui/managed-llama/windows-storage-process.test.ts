import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import { verifyWindowsLlamaStorage } from "./windows-storage.js";

const mocked = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocked.execFile }));
type Callback = (error: Error | null, stdout?: string, stderr?: string) => void;
const failures = channel("abot.managed-llama.windows-storage-failure");
const observed: unknown[] = [];
const collect = (value: unknown) => { observed.push(value); };
afterEach(() => {
  failures.unsubscribe(collect); observed.length = 0;
  mocked.execFile.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

test.each(["path", "private", "create-directory", "create-file"] as const)(
  "%s invokes one bounded helper with only its isolated environment", async access => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    vi.stubEnv("OPENAI_API_KEY", "foreign-secret");
    vi.stubEnv("NODE_OPTIONS", "foreign-loader");
    vi.stubEnv("PSModulePath", "foreign-modules");
    mocked.execFile.mockImplementation((_file, _args, _options, callback: Callback) => callback(null, "", ""));
    failures.subscribe(collect);
    const path = "C:\\fixtures\\מודל with spaces; 'quoted'";
    await expect(verifyWindowsLlamaStorage(path, access)).resolves.toBeUndefined();
    expect(mocked.execFile).toHaveBeenCalledOnce();
    const [executable, args, options] = mocked.execFile.mock.calls[0]!;
    expect(executable).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[4], "base64").toString("utf16le")).not.toContain(path);
    expect(options).toEqual({
      windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
      env: { SystemRoot: "D:\\Windows", PATH: "D:\\Windows\\System32", ABOT_LLAMA_PATH: path, ABOT_LLAMA_ACCESS: access },
    });
    expect(observed).toEqual([]);
  },
);

test.each([
  { fields: { killed: true, signal: "SIGTERM", code: null }, elapsed: 10_008, kind: "timeout" },
  { fields: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, elapsed: 400, kind: "output-limit" },
  { fields: { code: "ENOENT" }, elapsed: 4, kind: "spawn" },
  { fields: { code: 1 }, elapsed: 800, kind: "process-exit" },
])("$kind remains fail-closed, reports sanitized evidence and never retries", async ({ fields, elapsed, kind }) => {
  const secret = "private-path-and-credential-canary";
  const error = Object.assign(new Error(secret), fields, { stdout: secret, stderr: secret, path: secret });
  mocked.execFile.mockImplementation((_file, _args, _options, callback: Callback) => callback(error));
  vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(100 + elapsed);
  failures.subscribe(collect);
  await expect(verifyWindowsLlamaStorage(secret)).rejects.toMatchObject({
    code: "storage_unavailable", message: "Private Windows storage could not be verified.",
  });
  expect(mocked.execFile).toHaveBeenCalledOnce();
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ kind, access: "private", elapsedMs: elapsed });
  expect(JSON.stringify(observed)).not.toContain(secret);
});
