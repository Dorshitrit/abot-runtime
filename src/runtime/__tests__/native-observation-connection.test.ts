import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { expect, test, vi } from "vitest";
import { connectNativeObservations } from "../../computer-access/native-observation-connection.js";
import { startDesktopCollector } from "../../computer-access/companion/observation-process.js";
import type { PassiveCollectorEvent } from "../../shared/passive-observation.js";
import { LearningCollectionSource } from "../passive-learning/collection-source.js";

let fixtureId = 0;

function fixture() {
  const abort = new AbortController();
  const onEvent = vi.fn();
  const release = vi.fn(async () => {});
  const acquireOwnership = vi.fn(async () => ({ deviceId: "stable-device", release }));
  let stopped: (() => void) | undefined;
  const close = vi.fn(() => stopped?.());
  let emit!: (event: PassiveCollectorEvent) => void;
  const startCollector = vi.fn<typeof startDesktopCollector>((input) => {
    emit = input.onEvent; stopped = input.onStopped; return { close };
  });
  const options = { rootDir: `fixture-root-${++fixtureId}`, ownerId: "dev", leaseId: "lease-a",
    excludedApplications: ["private-app"], abortSignal: abort.signal, onEvent };
  const dependencies = { acquireOwnership, startCollector };
  return { abort, onEvent, release, acquireOwnership, close, startCollector, options, dependencies,
    emit: (event: PassiveCollectorEvent) => emit(event) };
}

test("native events retain trusted device, owner and lease bindings and reject late callbacks", async () => {
  const f = fixture();
  const connection = await connectNativeObservations(f.options, f.dependencies);
  expect(f.startCollector).toHaveBeenCalledWith(expect.objectContaining({ excludedApplications: ["private-app"] }));
  f.emit({ type: "status", state: "partial" });
  expect(f.onEvent).toHaveBeenCalledExactlyOnceWith({ type: "status", state: "partial",
    deviceId: "stable-device", ownerId: "dev", leaseId: "lease-a" });
  connection.close(); connection.close(); f.abort.abort();
  f.emit({ type: "status", state: "collecting" });
  expect(f.onEvent).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});

test("already aborted subscriptions cannot acquire ownership or start a helper", async () => {
  const f = fixture(); f.abort.abort();
  await expect(connectNativeObservations(f.options, f.dependencies)).rejects.toThrow();
  expect(f.acquireOwnership).not.toHaveBeenCalled();
  expect(f.startCollector).not.toHaveBeenCalled();
});

test("abort during ownership acquisition releases the lock without starting a helper", async () => {
  const f = fixture();
  f.acquireOwnership.mockImplementationOnce(async () => {
    f.abort.abort(); return { deviceId: "stable-device", release: f.release };
  });
  await expect(connectNativeObservations(f.options, f.dependencies)).rejects.toThrow();
  expect(f.startCollector).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

test("abort during a synchronous startup event still closes the returned helper", async () => {
  const f = fixture();
  f.onEvent.mockImplementationOnce(() => f.abort.abort());
  f.startCollector.mockImplementationOnce((input) => {
    input.onEvent({ type: "status", state: "starting" });
    return { close: () => { f.close(); input.onStopped?.(); } };
  });
  const connection = await connectNativeObservations(f.options, f.dependencies);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
  connection.close();
  expect(f.close).toHaveBeenCalledOnce();
});

test("a synchronous spawn failure confirms no helper exists and releases ownership", async () => {
  const f = fixture();
  const spawnProcess = vi.fn<typeof spawn>(() => { throw new Error("private diagnostic"); });
  await connectNativeObservations(f.options, { acquireOwnership: f.acquireOwnership,
    startCollector: (input) => startDesktopCollector({ ...input, platform: "win32", spawnProcess: spawnProcess as unknown as typeof spawn }),
  });
  expect(f.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
    type: "status", state: "failed", reason: "collector_start_failed",
  }));
  expect(f.release).toHaveBeenCalledOnce();
});

test("direct delivery still uses the real collector filter for exclusions, redaction and output limits", async () => {
  const f = fixture();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const spawnProcess = vi.fn<typeof spawn>().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const connection = await connectNativeObservations(f.options, {
    acquireOwnership: f.acquireOwnership,
    startCollector: (input) => startDesktopCollector({ ...input, platform: "win32", spawnProcess: spawnProcess as unknown as typeof spawn }),
  });
  const snapshot = { type: "snapshot", beforeKey: "view", afterKey: "view", kind: "view",
    extraction: "uia", coverage: "partial", content: "password=private-value",
    source: { app: "private-app", windowId: "window", title: "Document" } };
  child.stdout.write(JSON.stringify(snapshot) + "\n");
  expect(f.onEvent).toHaveBeenCalledTimes(1);
  child.stdout.write(JSON.stringify({ ...snapshot, source: { ...snapshot.source, app: "editor" } }) + "\n");
  expect(f.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
    deviceId: "stable-device", observation: expect.objectContaining({ content: "[REDACTED]" }),
  }));
  child.stdout.write(Buffer.alloc(128 * 1024 + 1, 97));
  expect(f.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", reason: "collector_output_limit" }));
  connection.close();
});

test("an unconfirmed helper stop retains ownership without interrupting service cleanup", async () => {
  const f = fixture();
  const connection = await connectNativeObservations(f.options, f.dependencies);
  f.close.mockImplementationOnce(() => { throw new Error("private stop diagnostic"); });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    expect(connection.close).not.toThrow();
    expect(connection.close).not.toThrow();
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.any(String), { code: "NATIVE_OBSERVATION_STOP_UNCONFIRMED" });
  } finally { warning.mockRestore(); }
  expect(f.release).not.toHaveBeenCalled();
  f.emit({ type: "status", state: "collecting" });
  expect(f.onEvent).not.toHaveBeenCalled();
});

test("a throwing startup event consumer cannot recurse into startup-failure delivery or leak its returned helper", async () => {
  const f = fixture();
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  f.onEvent.mockImplementationOnce(() => { throw new Error("consumer failure"); });
  f.startCollector.mockImplementationOnce((input) => {
    input.onEvent({ type: "status", state: "starting" });
    expect(f.release).not.toHaveBeenCalled();
    return { close: () => { f.close(); input.onStopped?.(); } };
  });
  try {
    await connectNativeObservations(f.options, f.dependencies);
    expect(f.onEvent).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.any(String), { code: "NATIVE_OBSERVATION_DELIVERY_FAILED" });
  } finally { warning.mockRestore(); }
});


test.each([false, true])("kill returning %s retains native ownership until the helper actually exits", async (killResult) => {
  const f = fixture();
  const killGroup = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("fake process group"); });
  const child = Object.assign(new EventEmitter(), {
    pid: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => killResult),
  });
  const spawnProcess = vi.fn<typeof spawn>().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  try {
    const connection = await connectNativeObservations(f.options, { acquireOwnership: f.acquireOwnership,
      startCollector: (input) => startDesktopCollector({ ...input, platform: "win32", spawnProcess: spawnProcess as unknown as typeof spawn }),
    });
    connection.close();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    child.stdout.write(JSON.stringify({ type: "status", state: "collecting" }) + "\n");
    expect(f.onEvent).toHaveBeenCalledOnce();
    child.emit("exit", 0);
    expect(f.release).toHaveBeenCalledOnce();
    f.abort.abort(); connection.close(); child.emit("exit", 0);
    expect(f.release).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  } finally { killGroup.mockRestore(); }
});


test("a failed spawn without a process reports its status before releasing ownership", async () => {
  const f = fixture();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const spawnProcess = vi.fn<typeof spawn>().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  await connectNativeObservations(f.options, { acquireOwnership: f.acquireOwnership,
    startCollector: (input) => startDesktopCollector({ ...input, platform: "win32", spawnProcess: spawnProcess as unknown as typeof spawn }),
  });
  child.emit("error", new Error("private spawn diagnostic"));
  expect(f.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
    state: "unavailable", reason: "collector_dependency_unavailable",
  }));
  expect(f.release).toHaveBeenCalledOnce();
  child.emit("exit", 1);
  expect(f.release).toHaveBeenCalledOnce();
});


test("an explicit source restart waits for its own exit and lock release before applying new exclusions", async () => {
  const f = fixture();
  const starts: Parameters<typeof startDesktopCollector>[0][] = [];
  let held = false;
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolveRelease) => { releaseFirst = resolveRelease; });
  let acquisitions = 0;
  f.acquireOwnership.mockImplementation(async () => {
    if (held) throw new Error("host_observations_already_owned");
    held = true;
    const first = ++acquisitions === 1;
    return { deviceId: "stable-device", release: vi.fn(async () => {
      if (first) await firstRelease;
      held = false;
    }) };
  });
  f.startCollector.mockImplementation((input) => { starts.push(input); return { close: f.close }; });
  const failed = vi.fn(), event = vi.fn();
  let excludedApplications = ["first-private-app"];
  const source = new LearningCollectionSource({ ownerId: "dev", enabled: () => true,
    excludedApplications: () => excludedApplications, opening: vi.fn(), failed, event,
    connect: (input) => connectNativeObservations({ ...input, rootDir: f.options.rootDir }, f.dependencies),
  });
  vi.useFakeTimers();
  try {
    await source.open();
    excludedApplications = ["second-private-app"];
    const restarted = source.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.close).toHaveBeenCalledOnce();
    expect(starts).toHaveLength(1);
    starts[0]!.onEvent({ type: "status", state: "collecting" });
    expect(event).not.toHaveBeenCalled();
    starts[0]!.onStopped?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(acquisitions).toBe(1);
    expect(starts).toHaveLength(1);
    releaseFirst(); await restarted;
    expect(starts).toHaveLength(2);
    expect(starts[1]!.excludedApplications).toEqual(["second-private-app"]);
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    starts[0]!.onEvent({ type: "status", state: "collecting" });
    expect(event).not.toHaveBeenCalled();
  } finally {
    releaseFirst(); source.close(); starts.at(-1)?.onStopped?.();
    await Promise.resolve(); vi.useRealTimers();
  }
});


test("a lock release failure keeps replacement collection closed after confirmed exit", async () => {
  const f = fixture();
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  f.release.mockRejectedValueOnce(new Error("private release diagnostic"));
  vi.useFakeTimers();
  try {
    const first = await connectNativeObservations(f.options, f.dependencies);
    first.close();
    await vi.advanceTimersByTimeAsync(0);
    const failed = expect(connectNativeObservations(f.options, f.dependencies)).rejects.toThrow("host_observations_already_owned");
    await vi.advanceTimersByTimeAsync(2_000); await failed;
    expect(f.acquireOwnership).toHaveBeenCalledOnce();
    expect(f.startCollector).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.any(String), { code: "NATIVE_OBSERVATION_RELEASE_FAILED" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { warning.mockRestore(); vi.useRealTimers(); }
});
