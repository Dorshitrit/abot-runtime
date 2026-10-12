import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import { observeLockReadFailure } from "../adapters/long-term-memory/file-lock/path-observation.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.readdir).mockImplementation(actual.readdir);
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

function windowsPlatform() {
  const nativeProcess = Object.create(process);
  Object.defineProperty(nativeProcess, "platform", { value: "win32" });
  vi.stubGlobal("process", nativeProcess);
}

test.each(["lock", "lease"])("a %s removed during observation allows the next owner to acquire normally", async (part) => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const parent = join(process.cwd(), ".codex/artifacts/file-lock-path-observation");
  await actual.mkdir(parent, { recursive: true });
  const root = await actual.mkdtemp(join(parent, "case-"));
  roots.push(root);
  const lockPath = join(root, "state.lock");
  const observed = part === "lock" ? lockPath : join(lockPath, "lease");
  const release = await acquireFileLock(lockPath, {});
  let injected = false;
  vi.mocked(fs.readdir).mockImplementation((async (
    path: Parameters<typeof fs.readdir>[0], options: Parameters<typeof fs.readdir>[1],
  ) => {
    if (String(path) !== observed || injected) return actual.readdir(path, options);
    injected = true;
    await release();
    throw Object.assign(new Error("Windows pending directory deletion"), { code: "EPERM" });
  }) as typeof fs.readdir);
  windowsPlatform();
  const nextRelease = await acquireFileLock(lockPath, { waitMs: 1000, retryDelayMs: 1 });
  expect(injected).toBe(true);
  await nextRelease();
  expect(await actual.readdir(root)).toEqual([]);
});

test.each(["existing", "unreadable"])("an %s lock observation keeps its permission failure", async (kind) => {
  windowsPlatform();
  const error = Object.assign(new Error("Denied"), { code: "EPERM" });
  if (kind === "existing") vi.mocked(fs.lstat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof fs.lstat>>);
  else vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error("Denied again"), { code: "EPERM" }));
  expect(await observeLockReadFailure("state.lock", error)).toBe(error);
});
