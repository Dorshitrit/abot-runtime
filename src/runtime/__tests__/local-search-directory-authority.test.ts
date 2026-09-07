import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveSearchRoot } from "../../../plugins/local-search/source/paths.js";
import { spawnRipgrepProcess } from "../../../plugins/local-search/source/ripgrep-process.js";
import { runRipgrepPathSearch } from "../../../plugins/local-search/source/ripgrep.js";
import { spawnDirectoryAuthorityCommand } from "../../shared/directory-authority/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../shared/directory-authority/index.js", () => ({
  spawnDirectoryAuthorityCommand: vi.fn(),
}));

const temporaryRoots: string[] = [];
const authority = { directoryPath: "/verified/root", directoryFd: 42 };

function stubMacPlatform(): void {
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get(target, property, receiver) {
        if (property === "platform") return "darwin";
        return Reflect.get(target, property, receiver);
      },
    }),
  );
}

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 43210,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
}

async function rootContext() {
  const root = await mkdtemp(join(tmpdir(), "local-search-macos-"));
  temporaryRoots.push(root);
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: root,
    sessionsDir: join(root, "sessions"),
    attachmentsDir: join(root, "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"),
    compiledDir: join(root, "compiled"),
    traceFile: join(root, "trace.jsonl"),
  };
  return {
    id: "local-search",
    path: join(process.cwd(), "plugins/local-search/plugin.json"),
    stateDir: join(root, "plugin-state"),
    rootDir: root,
    runtimeId: "local-search-authority-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    config: {},
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local-search macOS directory authority", () => {
  test("retains a real directory descriptor for the macOS bridge", async () => {
    const context = await rootContext();
    stubMacPlatform();
    const root = await resolveSearchRoot(context, ".");
    try {
      expect(root.directoryAuthority).toEqual({
        directoryPath: context.rootDir,
        directoryFd: expect.any(Number),
      });
      expect(root.commandDirectory).toBe(context.rootDir);
      expect(root.commandTarget).toBe(".");
      expect(root.stdinFd).toBeUndefined();
    } finally {
      await root.close();
    }
  });

  test("keeps macOS regular files on the descriptor-backed stdin path", async () => {
    const context = await rootContext();
    await writeFile(join(context.rootDir, "selected.txt"), "needle\n");
    stubMacPlatform();
    const root = await resolveSearchRoot(context, "selected.txt");
    try {
      expect(root.stdinFd).toEqual(expect.any(Number));
      expect(root.directoryAuthority).toBeUndefined();
      expect(root.commandTarget).toBe("-");
    } finally {
      await root.close();
    }
  });

  test("routes verified directory descriptors through the bridge and preserves ripgrep isolation", () => {
    const child = fakeChild();
    vi.mocked(spawnDirectoryAuthorityCommand).mockReturnValue(child);
    vi.stubEnv("RIPGREP_CONFIG_PATH", "/untrusted/config");
    try {
      spawnRipgrepProcess(
        ["--files", "."],
        "/ignored/cwd",
        undefined,
        authority,
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnDirectoryAuthorityCommand).toHaveBeenCalledWith({
        ...authority,
        command: expect.any(String),
        args: ["--no-config", "--files", "."],
        env: expect.not.objectContaining({
          RIPGREP_CONFIG_PATH: expect.anything(),
        }),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("keeps direct descriptor-backed process invocation and termination unchanged", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const invocation = spawnRipgrepProcess(["--json", "needle", "-"], "/", 42);
    invocation.terminate();
    expect(spawnDirectoryAuthorityCommand).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ["--no-config", "--json", "needle", "-"],
      {
        cwd: "/",
        env: expect.any(Object),
        stdio: [42, "pipe", "pipe"],
        windowsHide: true,
      },
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("kills the helper process group when an extra match proves truncation", async () => {
    const child = fakeChild();
    vi.mocked(spawnDirectoryAuthorityCommand).mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const result = runRipgrepPathSearch(
      ["--files"],
      "/ignored",
      1,
      undefined,
      authority,
    );
    child.stdout.emit("data", Buffer.from("first.txt\0extra.txt\0"));
    child.emit("close", null);
    await expect(result).resolves.toEqual({
      items: ["first.txt"],
      truncated: true,
    });
    expect(kill).toHaveBeenCalledWith(-child.pid!, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  test.each(["abort", "timeout"] as const)(
    "kills the helper group on %s",
    async (reason) => {
      vi.useFakeTimers();
      const child = fakeChild();
      vi.mocked(spawnDirectoryAuthorityCommand).mockReturnValue(child);
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const controller = new AbortController();
      const result = runRipgrepPathSearch(
        ["--files"],
        "/ignored",
        1,
        controller.signal,
        authority,
      );
      const rejection = expect(result).rejects.toMatchObject({
        code: "local_search_failed",
      });
      if (reason === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(10_000);
      child.emit("close", null);
      await rejection;
      expect(kill).toHaveBeenCalledWith(-child.pid!, "SIGKILL");
    },
  );

  test("treats a helper startup failure as search failure instead of empty results", async () => {
    const child = fakeChild();
    vi.mocked(spawnDirectoryAuthorityCommand).mockReturnValue(child);
    const result = runRipgrepPathSearch(
      ["--files"],
      "/ignored",
      1,
      undefined,
      authority,
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: "local_search_failed",
    });
    child.emit("close", 125);
    await rejection;
  });
});
