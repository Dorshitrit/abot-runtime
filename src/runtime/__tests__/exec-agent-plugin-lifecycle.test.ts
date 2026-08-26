import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import createExecPlugin from "../../../plugins/exec/source/index.js";
import { createExecProcessManager } from "../../../plugins/exec/source/process-manager.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES } from "../orchestration/capability-adapters/result.js";
import type {
  RuntimePluginEntrypoint,
  RuntimePluginLoadContext,
  ToolExecutionContext,
  ToolImplementationOutput,
} from "../plugin.js";
import type { RuntimePaths } from "../ports.js";

const rootDir = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRuntimePaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), "exec-plugin-lifecycle-"));
  temporaryRoots.push(root);
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: join(root, "agent-work"),
    sessionsDir: join(root, ".runtime", "sessions"),
    attachmentsDir: join(root, ".runtime", "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"),
    compiledDir: join(root, "compiled"),
    traceFile: join(root, ".runtime", "trace.ndjson"),
  };
  await Promise.all(
    Object.values(runtimePaths)
      .filter(
        (directory) => directory !== root && !directory.endsWith(".ndjson"),
      )
      .map((directory) => mkdir(directory, { recursive: true })),
  );
  return runtimePaths;
}

function loadPlugin(
  runtimePaths: RuntimePaths,
  config: Readonly<Record<string, unknown>>,
): RuntimePluginEntrypoint {
  const pluginRoot = join(rootDir, "plugins", "exec");
  const context: RuntimePluginLoadContext & Readonly<{ pluginRoot: string }> = {
    id: "exec",
    path: join(pluginRoot, "plugin.json"),
    stateDir: join(runtimePaths.runtimeDir, "plugins", "exec"),
    rootDir: runtimePaths.rootDir,
    runtimeId: "exec-plugin-lifecycle-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    pluginRoot,
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    config,
  };
  return createExecPlugin(context);
}

const longRunningSettings = Object.freeze({
  timeoutMs: 5_000,
  yieldAfterMs: 20,
  idleTimeoutMs: 5_000,
  outputMaxChars: 8_000,
});

describe("exec plugin process lifecycle", () => {
  test("isolates process ownership between plugin factories", async () => {
    const runtimePaths = await createRuntimePaths();
    const first = loadPlugin(runtimePaths, longRunningSettings);
    const second = loadPlugin(runtimePaths, longRunningSettings);
    const context: ToolExecutionContext = {
      sharedState: { currentSessionId: "factory-isolation" },
    };
    const running = await first.handlers.exec?.(
      { command: "sleep 2", cwd: "." },
      context,
    );
    const processId = String(running?.data?.processId ?? "");

    await expect(
      second.handlers.exec_wait?.(
        { process_id: processId, cursor: 1 },
        context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "unknown_exec_process",
    });
    await expect(
      first.handlers.exec_cancel?.({ process_id: processId }, context),
    ).resolves.toMatchObject({ ok: true, exitCode: 130 });
  });

  test("enforces the per-instance concurrency limit and releases cancellations", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, longRunningSettings);
    const context: ToolExecutionContext = {
      sharedState: { currentSessionId: "concurrency" },
    };
    const active: Array<ToolImplementationOutput | undefined> = [];
    for (let index = 0; index < 4; index += 1) {
      active.push(
        await handlers.exec?.({ command: "sleep 2", cwd: "." }, context),
      );
    }
    await expect(
      handlers.exec?.({ command: "sleep 2", cwd: "." }, context),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "exec_process_limit_reached",
    });
    for (const running of active) {
      await expect(
        handlers.exec_cancel?.(
          { process_id: String(running?.data?.processId ?? "") },
          context,
        ),
      ).resolves.toMatchObject({ ok: true, exitCode: 130 });
    }
    let released = await handlers.exec?.(
      { command: "printf released", cwd: "." },
      context,
    );
    const stdoutChunks = [released?.stdout ?? ""];
    expect(released).not.toMatchObject({
      errorCode: "exec_process_limit_reached",
    });
    for (
      let observation = 0;
      released?.errorCode === "exec_process_running" && observation < 50;
      observation += 1
    ) {
      released = await handlers.exec_wait?.(
        {
          process_id: String(released.data?.processId ?? ""),
          cursor: Number(released.data?.nextCursor ?? 0),
        },
        context,
      );
      stdoutChunks.push(released?.stdout ?? "");
    }
    expect(released).toMatchObject({ ok: true });
    expect(stdoutChunks.join("")).toBe("released");
  });

  test("rejects stale cursors without consuming the process", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, longRunningSettings);
    const context: ToolExecutionContext = {
      sharedState: { currentSessionId: "stale-cursor" },
    };
    const running = await handlers.exec?.(
      { command: "sleep 2", cwd: "." },
      context,
    );
    const processId = String(running?.data?.processId ?? "");
    await expect(
      handlers.exec_wait?.({ process_id: processId, cursor: 2 }, context),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "stale_exec_process_cursor",
    });
    await expect(
      handlers.exec_cancel?.({ process_id: processId }, context),
    ).resolves.toMatchObject({ ok: true });
  });

  test("serializes concurrent waits so one cursor can advance only once", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, longRunningSettings);
    const context: ToolExecutionContext = {
      sharedState: { currentSessionId: "concurrent-waits" },
    };
    const running = await handlers.exec?.(
      { command: "sleep 2", cwd: "." },
      context,
    );
    const processId = String(running?.data?.processId ?? "");

    const results = await Promise.all([
      handlers.exec_wait?.({ process_id: processId, cursor: 1 }, context),
      handlers.exec_wait?.({ process_id: processId, cursor: 1 }, context),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          errorCode: "exec_process_running",
          data: expect.objectContaining({ nextCursor: 2 }),
        }),
        expect.objectContaining({
          ok: false,
          errorCode: "exec_wait_in_progress",
        }),
      ]),
    );
    await expect(
      handlers.exec_cancel?.({ process_id: processId }, context),
    ).resolves.toMatchObject({ ok: true, exitCode: 130 });
  });

  test("lets cancellation claim a process while a wait is in flight", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, longRunningSettings);
    const context: ToolExecutionContext = {
      sharedState: { currentSessionId: "wait-cancel" },
    };
    const running = await handlers.exec?.(
      { command: "sleep 2", cwd: "." },
      context,
    );
    const processId = String(running?.data?.processId ?? "");

    const [waited, cancelled] = await Promise.all([
      handlers.exec_wait?.({ process_id: processId, cursor: 1 }, context),
      handlers.exec_cancel?.({ process_id: processId }, context),
    ]);

    expect(waited).toMatchObject({
      ok: false,
      errorCode: "unknown_exec_process",
    });
    expect(cancelled).toMatchObject({ ok: true, exitCode: 130 });
    await expect(
      handlers.exec_wait?.({ process_id: processId, cursor: 2 }, context),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "unknown_exec_process",
    });
  });

  test("does not hold the process transition lock across a long wait window", async () => {
    const runtimePaths = await createRuntimePaths();
    const manager = createExecProcessManager();
    const scope = "prompt-cancel";
    const running = await manager.start({
      scope,
      shellCommand: "sleep 4",
      cwd: runtimePaths.agentWorkDir,
      outputMaxChars: 512,
      yieldAfterMs: 10,
      idleTimeoutMs: 5_000,
      hardTimeoutMs: 5_000,
    });
    const waitOutcome = manager
      .wait({
        processId: running.processId,
        scope,
        cursor: 1,
        waitMs: 2_000,
      })
      .then(
        (snapshot) => ({ snapshot }),
        (error: unknown) => ({ error }),
      );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const cancelStartedAt = Date.now();
    const cancelled = await manager.cancel({
      processId: running.processId,
      scope,
    });
    const cancellationElapsedMs = Date.now() - cancelStartedAt;

    expect(cancellationElapsedMs).toBeLessThan(750);
    expect(cancelled).toMatchObject({
      status: "settled",
      exitCode: 130,
      terminationReason: "cancelled",
    });
    await expect(waitOutcome).resolves.toMatchObject({
      error: {
        code: "unknown_exec_process",
      },
    });
    await manager.release(running.processId, scope);
  });

  test("bounds stdout, stderr, and rendered output with explicit metadata", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, {
      timeoutMs: 5_000,
      yieldAfterMs: 5_000,
      idleTimeoutMs: 5_000,
      outputMaxChars: 128,
    });
    const result = await handlers.exec?.({
      command:
        "node -e \"process.stdout.write('x'.repeat(500)); process.stderr.write('y'.repeat(500))\"",
      cwd: ".",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outputBounds: {
          maxChars: 128,
          stdout: { truncated: true, originalChars: 500 },
          stderr: { truncated: true, originalChars: 500 },
          rendered: { truncated: true },
        },
      },
    });
    expect(result?.output.length).toBeLessThanOrEqual(128);
    expect(result?.stdout?.length).toBeLessThanOrEqual(128);
    expect(result?.stderr?.length).toBeLessThanOrEqual(128);
  });

  test("keeps the complete maximum-output result below the runtime boundary", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, {
      timeoutMs: 5_000,
      yieldAfterMs: 5_000,
      idleTimeoutMs: 5_000,
      outputMaxChars: 8_000,
    });
    const result = await handlers.exec?.({
      command:
        "node -e \"process.stdout.write('😀'.repeat(20000)); process.stderr.write('🚨'.repeat(20000))\"",
      cwd: ".",
    });

    expect(result?.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
    );
    expect(() =>
      loadPlugin(runtimePaths, {
        timeoutMs: 5_000,
        yieldAfterMs: 5_000,
        idleTimeoutMs: 5_000,
        outputMaxChars: 8_001,
      }),
    ).toThrow();
  });

  test("reports hard and idle timeouts with stable failure codes", async () => {
    const runtimePaths = await createRuntimePaths();
    const hardTimeoutPlugin = loadPlugin(runtimePaths, {
      timeoutMs: 60,
      yieldAfterMs: 500,
      idleTimeoutMs: 500,
      outputMaxChars: 512,
    });
    await expect(
      hardTimeoutPlugin.handlers.exec?.({
        command: "node -e \"setInterval(() => process.stdout.write('x'), 5)\"",
        cwd: ".",
      }),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 124,
      errorCode: "exec_hard_timeout",
    });

    const idleTimeoutPlugin = loadPlugin(runtimePaths, {
      timeoutMs: 1_000,
      yieldAfterMs: 1_000,
      idleTimeoutMs: 40,
      outputMaxChars: 512,
    });
    await expect(
      idleTimeoutPlugin.handlers.exec?.({ command: "sleep 2", cwd: "." }),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 124,
      errorCode: "exec_idle_timeout",
    });
  });

  test("aborts and disposes a terminal process", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, {
      timeoutMs: 5_000,
      yieldAfterMs: 5_000,
      idleTimeoutMs: 5_000,
      outputMaxChars: 512,
    });
    const controller = new AbortController();
    controller.abort();
    const context: ToolExecutionContext = {
      abortSignal: controller.signal,
      sharedState: { currentSessionId: "aborted-process" },
    };
    const aborted = await handlers.exec?.(
      { command: "sleep 2", cwd: "." },
      context,
    );
    expect(aborted).toMatchObject({
      ok: false,
      exitCode: 130,
      errorCode: "exec_aborted",
    });
    await expect(
      handlers.exec_wait?.(
        {
          process_id: String(aborted?.data?.processId ?? ""),
          cursor: 1,
        },
        context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "unknown_exec_process",
    });
  });

  test("returns canonical path failures before the shell starts", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, longRunningSettings);

    await expect(
      handlers.exec?.({ command: "cat /etc/passwd", cwd: "." }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
    });
    await expect(
      handlers.exec?.({ command: "printf ok", cwd: "workspace/../.." }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
    });
  });
});
