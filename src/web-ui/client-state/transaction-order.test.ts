import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acquireFileLock } from "../../runtime/adapters/long-term-memory/file-lock/acquisition.js";
import { WebClientStateStore } from "./store.js";

vi.mock("../../runtime/adapters/long-term-memory/file-lock/acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/adapters/long-term-memory/file-lock/acquisition.js")>();
  return { ...actual, acquireFileLock: vi.fn(actual.acquireFileLock) };
});

const roots: string[] = [];
let acquire: typeof acquireFileLock;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../../runtime/adapters/long-term-memory/file-lock/acquisition.js")>(
    "../../runtime/adapters/long-term-memory/file-lock/acquisition.js",
  );
  acquire = actual.acquireFileLock;
  vi.mocked(acquireFileLock).mockReset().mockImplementation(acquire);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, release };
}

async function fixture() {
  const parent = join(process.cwd(), ".codex", "artifacts", "client-state-transaction-order");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  roots.push(root);
  const first = new WebClientStateStore(root);
  const second = new WebClientStateStore(root);
  // Finish directory initialization before observing transaction admission.
  await first.transaction(() => null);
  await second.transaction(() => null);
  vi.mocked(acquireFileLock).mockClear();
  return { first, second };
}

function holdNextPhysicalRelease() {
  const releasing = barrier();
  const resume = barrier();
  vi.mocked(acquireFileLock).mockImplementationOnce(async (path, options) => {
    const release = await acquire(path, options);
    return async () => {
      releasing.release();
      await resume.waiting;
      await release();
    };
  });
  return { releasing: releasing.waiting, resume: resume.release };
}

test("same-file store instances wait for physical release before their first lock attempt", async () => {
  const { first, second } = await fixture();
  const gate = holdNextPhysicalRelease();
  const firstResult = first.transaction((state) => { state.introductionSeen = true; return "first"; });
  await gate.releasing;
  const secondResult = second.transaction((state) => {
    state.preferences["abot-web.lastToolPermissionMode"] = "full_access";
    return "second";
  });
  try {
    await setImmediate();
    expect(acquireFileLock).toHaveBeenCalledTimes(1);
  } finally {
    gate.resume();
    await Promise.allSettled([firstResult, secondResult]);
  }
  expect((await firstResult).result).toBe("first");
  const saved = await secondResult;
  expect(saved.result).toBe("second");
  expect(saved.state.introductionSeen).toBe(true);
  expect(saved.state.preferences["abot-web.lastToolPermissionMode"]).toBe("full_access");
  expect(saved.state.revision).toBe(2);
  expect(acquireFileLock).toHaveBeenCalledTimes(2);
});

test("a rejected transaction preserves its error and lets a queued store instance continue", async () => {
  const { first, second } = await fixture();
  const gate = holdNextPhysicalRelease();
  const failure = new Error("Preference write rejected");
  const rejected = first.transaction((state) => {
    state.introductionSeen = true;
    throw failure;
  }).catch((error: unknown) => error);
  await gate.releasing;
  const following = second.transaction((state) => {
    state.preferences["abot-web.lastToolPermissionMode"] = "full_access";
    return "saved";
  });
  try {
    await setImmediate();
    expect(acquireFileLock).toHaveBeenCalledTimes(1);
  } finally {
    gate.resume();
    await Promise.allSettled([rejected, following]);
  }
  expect(await rejected).toBe(failure);
  const saved = await following;
  expect(saved.result).toBe("saved");
  expect(saved.state.introductionSeen).toBe(false);
  expect(saved.state.preferences["abot-web.lastToolPermissionMode"]).toBe("full_access");
  expect(saved.state.revision).toBe(1);
});

test("an unrelated installation can acquire and finish while another lock awaits release", async () => {
  const { first } = await fixture();
  const { first: independent } = await fixture();
  const gate = holdNextPhysicalRelease();
  const held = first.transaction(() => "held");
  await gate.releasing;
  const other = independent.transaction(() => "independent");
  try {
    await setImmediate();
    expect(acquireFileLock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(acquireFileLock).mock.calls.map(([path]) => path)).toEqual([
      join(first.directory, "state.lock"),
      join(independent.directory, "state.lock"),
    ]);
    expect((await other).result).toBe("independent");
  } finally {
    gate.resume();
    await Promise.allSettled([held, other]);
  }
  expect((await held).result).toBe("held");
});
