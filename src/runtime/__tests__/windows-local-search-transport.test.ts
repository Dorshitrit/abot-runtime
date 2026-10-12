import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { spawnRipgrepProcess } from "../../../plugins/local-search/source/ripgrep-process.js";
import { runRipgrepPathSearch } from "../../../plugins/local-search/source/ripgrep.js";
import type { WindowsSearchAuthority } from "../../../plugins/local-search/source/windows-authority.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const authority: WindowsSearchAuthority = {
  platform: "win32",
  rootPath: "C:\\allowed",
  targetPath: "C:\\allowed\\target",
  isFile: false,
  rootIdentity: { device: "1", inode: "2", birthtimeNs: "3" },
  targetIdentity: { device: "1", inode: "4", birthtimeNs: "5" },
};

function child() {
  const process = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(
    process as unknown as ReturnType<typeof spawn>,
  );
  return process;
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("passes the pinned identity and arguments as data while disabling inherited ripgrep configuration", () => {
  const process = child();
  vi.stubEnv("RIPGREP_CONFIG_PATH", "untrusted");
  vi.stubEnv("Ripgrep_Config_Path", "also-untrusted");
  spawnRipgrepProcess(["--files", "--", "."], "unused", undefined, authority);
  expect(spawn).toHaveBeenCalledTimes(1);
  const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!;
  expect(executable).toMatch(/powershell\.exe$/i);
  expect(args).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    expect.any(String),
  ]);
  expect(
    Object.keys(options!.env!).some(
      (key) => key.toUpperCase() === "RIPGREP_CONFIG_PATH",
    ),
  ).toBe(false);
  const input = JSON.parse(process.stdin.read().toString());
  expect(JSON.parse(input.request)).toMatchObject({
    ...authority,
    command: expect.any(String),
    args: ["--no-config", "--files", "--", "."],
  });
});

test.each([
  [2, "local_search_failed"],
  [125, "local_search_authority_unavailable"],
  [126, "local_search_windows_unavailable"],
])(
  "reports helper exit %s without returning partial data",
  async (code, expected) => {
    const process = child();
    const result = runRipgrepPathSearch(
      ["--files"],
      "unused",
      5,
      undefined,
      authority,
    );
    const failure = expect(result).rejects.toMatchObject({ code: expected });
    process.stdout.emit("data", Buffer.from("partial.txt\0"));
    process.emit("close", code);
    await failure;
  },
);

test.each(["abort", "timeout"] as const)(
  "terminates the owning helper on %s and waits for close",
  async (reason) => {
    vi.useFakeTimers();
    const process = child();
    const controller = new AbortController();
    const result = runRipgrepPathSearch(
      ["--files"],
      "unused",
      5,
      controller.signal,
      authority,
    );
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const failure = expect(result).rejects.toMatchObject({
      code: "local_search_failed",
    });
    if (reason === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(10_000);
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    process.emit("close", null);
    await failure;
  },
);

test("truncation ends the owning helper and keeps only the requested matches", async () => {
  const process = child();
  const result = runRipgrepPathSearch(
    ["--files"],
    "unused",
    1,
    undefined,
    authority,
  );
  process.stdout.emit("data", Buffer.from("one.txt\0extra.txt\0"));
  expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  process.emit("close", null);
  await expect(result).resolves.toEqual({
    items: ["one.txt"],
    truncated: true,
  });
});
