import { afterEach, describe, expect, test, vi } from "vitest";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import { toolImageFixture } from "./support/tool-media-fixture.js";
import { RequestComputers } from "../../../plugins/system/source/computer/request-computers.js";
import { ExecRequestResources } from "../../../plugins/exec/source/request-resources.js";
import type { ExecProcessManager } from "../../../plugins/exec/source/process-manager.js";
import type {
  PendingExecExecution,
  ExecProcessSnapshot,
} from "../../../plugins/exec/source/types.js";
import { computerRoute, desktopFixture } from "./computer-plugin-fixtures.js";

afterEach(() => vi.useRealTimers());

describe("approval resource capsules", () => {
  test("releases request media and restores identical bytes and exact producer ownership", async () => {
    const first = new RequestToolResources();
    const owner = { callId: "call-2", executionId: "execution-4" };
    const scope = first.media.beginExecution(
      owner,
      new AbortController().signal,
    );
    const image = await scope.writer.writeImage({
      bytes: toolImageFixture(),
      mimeType: "image/png",
    });
    scope.finish([image]);
    const bytes = first.media.resolve(owner, image);
    const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
    await first.dispose();
    expect(() => first.media.resolve(owner, image)).toThrow("closed");
    const second = new RequestToolResources();
    second.restore(snapshot);
    expect(second.media.resolve(owner, image)).toBe(bytes);
    expect(() =>
      second.media.resolve({ ...owner, callId: "other" }, image),
    ).toThrow("mismatch");
    await second.dispose();
  });

  test("tracks request-owned work until settlement, independently of retained state", async () => {
    const resources = new RequestToolResources();
    let settle!: () => void;
    resources.work.trackUntil(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    resources.state.register("fixture.v1", {
      snapshot: () => ({ retained: true }),
    });
    expect(resources.hasActiveWork()).toBe(true);
    expect(() => resources.snapshot()).toThrow("not_quiescent");
    let quiescent = false;
    const ready = resources.waitForQuiescence().then(() => {
      quiescent = true;
    });
    await Promise.resolve();
    expect(quiescent).toBe(false);
    settle();
    await ready;
    expect(resources.hasActiveWork()).toBe(false);
    expect(resources.snapshot().capsules).toEqual({
      "fixture.v1": { retained: true },
    });
    const unrelated = new RequestToolResources();
    expect(unrelated.hasActiveWork()).toBe(false);
    await resources.dispose();
    await unrelated.dispose();
  });

  test("keeps desktop references and window bindings across disposal without extending expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const connection = {
      readHostStatus: vi.fn(),
      executeHostOperation: vi.fn(),
    };
    const first = new RequestComputers("/runtime", [computerRoute], connection);
    const original = first.entries[0]!;
    const observed = original.bindings.observe(desktopFixture());
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    await first.close();
    const second = new RequestComputers(
      "/runtime",
      [computerRoute],
      connection,
      undefined,
      saved,
    );
    const restored = second.require(original.ref);
    expect(
      restored.bindings.action(observed.observation_ref, {
        kind: "focus_window",
        window_ref: observed.windows[0]!.window_ref,
      }),
    ).toMatchObject({
      desktopBinding: "session:10",
      action: { kind: "focus_window", windowBinding: "pid:1/start:2/window:3" },
    });
    const third = new RequestComputers(
      "/runtime",
      [computerRoute],
      connection,
      undefined,
      saved,
    );
    vi.setSystemTime(220_001);
    expect(() =>
      third.require(original.ref).bindings.action(observed.observation_ref, {
        kind: "press_keys",
        keys: ["Enter"],
      }),
    ).toThrow("more than two minutes");
    const unavailable = new RequestComputers(
      "/runtime",
      [],
      connection,
      undefined,
      saved,
    );
    expect(unavailable.entries).toEqual([]);
    expect(() => unavailable.require(original.ref)).toThrow(
      "Select a desktop reference",
    );
    await unavailable.close();
    await second.close();
    await third.close();
  });

  test("restores terminal exec output and cursor without a process, while rejecting an active snapshot", async () => {
    const stream = {
      text: "unconsumed stdout",
      sawOutput: true,
      metadata: {
        truncated: false,
        originalChars: 17,
        returnedChars: 17,
        omittedChars: 0,
      },
    };
    const terminal: ExecProcessSnapshot = {
      processId: "exec-one",
      status: "settled",
      exitCode: 0,
      stdout: stream,
      stderr: { ...stream, text: "" },
      elapsedMs: 500,
      terminationReason: "completed",
    };
    const manager: ExecProcessManager = {
      start: vi.fn(),
      wait: vi.fn(),
      cancel: vi.fn(async () => terminal),
      release: vi.fn(async () => {}),
      snapshotSettled: vi.fn(() => ({ cursor: 3, snapshot: terminal })),
    };
    const execution: PendingExecExecution = {
      commandPreview: "fixture command",
      cwd: { absolutePath: "/runtime/work", logicalPath: "work" },
      filesystemStateBefore: {
        absoluteRoot: "/runtime/work",
        logicalRoot: "work",
        rootExists: true,
        complete: true,
        entries: new Map([
          ["one", { kind: "file", mode: 1, size: 1, mtimeMs: 1 }],
        ]),
      },
      hardTimeoutMs: 2000,
      idleTimeoutMs: 1000,
      outputMaxChars: 1000,
    };
    const first = new RequestToolResources();
    const pending = new Map([["exec-one", execution]]);
    const resource = new ExecRequestResources(manager, pending, {
      requestState: first.state,
    });
    let settle!: () => void;
    resource.started(
      "exec-one",
      "session-one",
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
      { requestWork: first.work },
    );
    expect(() => first.snapshot()).toThrow("not_quiescent");
    settle();
    await first.waitForQuiescence();
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    await first.dispose();
    expect(pending.size).toBe(0);
    const second = new RequestToolResources();
    second.restore(saved);
    const hydratedPending = new Map<string, PendingExecExecution>();
    const restored = new ExecRequestResources(manager, hydratedPending, {
      requestState: second.state,
    });
    second.assertRestoredStateClaimed();
    expect(
      hydratedPending
        .get("exec-one")!
        .filesystemStateBefore!.entries.get("one"),
    ).toEqual({ kind: "file", mode: 1, size: 1, mtimeMs: 1 });
    expect(() => restored.terminal("exec-one", "wrong-session", 3)).toThrow();
    expect(() => restored.terminal("exec-one", "session-one", 2)).toThrow(
      "stale",
    );
    expect(restored.terminal("exec-one", "session-one", 3)).toEqual(terminal);
    expect(restored.terminal("exec-one", "session-one", 3)).toBeUndefined();
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.wait).not.toHaveBeenCalled();
    await second.dispose();
  });

  test("unknown codec owners fail compatibility before execution", async () => {
    const resources = new RequestToolResources();
    resources.state.register("removed-plugin.v1", {
      snapshot: () => ({ exact: 1 }),
    });
    const snapshot = resources.snapshot();
    await resources.dispose();
    const restored = new RequestToolResources();
    restored.restore(snapshot);
    expect(() => restored.assertRestoredStateClaimed()).toThrow(
      "owner_unavailable",
    );
    await restored.dispose();
  });
});
