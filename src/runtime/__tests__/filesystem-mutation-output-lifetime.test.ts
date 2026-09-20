import { fstatSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { atomicWriteText } from "../../../plugins/filesystem/source/atomic-write.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

const opened = vi.hoisted(() => [] as { handle: FileHandle; closes: number }[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const record = { handle, closes: 0 };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        record.closes += 1;
        await close();
      };
      opened.push(record);
      return handle;
    },
  };
});

const nativePlatform = process.platform;
// Exercise the Darwin dispatch with real isolated I/O on Linux, not a native Mac run.
const backends =
  nativePlatform === "linux" ? ["linux", "darwin"] : [nativePlatform];
let root = "";
let work = "";

beforeEach(async () => {
  const artifacts = join(process.cwd(), ".codex", "artifacts");
  await mkdir(artifacts, { recursive: true });
  root = await mkdtemp(join(artifacts, "mutation-output-lifetime-"));
  work = join(root, "work");
  await mkdir(work);
  opened.length = 0;
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: nativePlatform });
  await rm(root, { recursive: true, force: true });
});

function target(relativePath: string) {
  return createRuntimeToolPathResolver({ agentWorkDir: work }).resolve(
    relativePath,
  );
}

function expectHandlesReleased() {
  expect(opened.length).toBeGreaterThan(0);
  for (const record of opened) {
    expect(record.closes).toBe(1);
    expect(record.handle.fd).toBe(-1);
  }
}

describe.each(backends)("%s committed file output lifetime", (backend) => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: backend });
  });

  test("reports the open root rather than the nested parent and closes all handles", async () => {
    const expectedRoot = statSync(work, { bigint: true });
    const calls: { handle: FileHandle; identity: typeof expectedRoot }[] = [];
    const onCommitted = (handle: FileHandle) => {
      calls.push({ handle, identity: fstatSync(handle.fd, { bigint: true }) });
    };
    await atomicWriteText({
      target: target("one/two/result.txt"),
      content: "committed",
      expectedVersion: { kind: "absent" },
      onCommitted,
    });
    expect(calls).toHaveLength(1);
    const held = calls[0]!.identity;
    expect(held.isDirectory()).toBe(true);
    expect(held.dev).toBe(expectedRoot.dev);
    expect(held.ino).toBe(expectedRoot.ino);
    expect(held.birthtimeNs).toBe(expectedRoot.birthtimeNs);
    expect(await readFile(join(work, "one/two/result.txt"), "utf8")).toBe(
      "committed",
    );
    expectHandlesReleased();
  });

  test("a throwing commit observer does not change success or leak handles", async () => {
    const onCommitted = vi.fn(() => {
      throw new Error("presentation failed");
    });
    await expect(
      atomicWriteText({
        target: target("one/two/result.txt"),
        content: "committed",
        expectedVersion: { kind: "absent" },
        onCommitted,
      }),
    ).resolves.toBeUndefined();
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(await readFile(join(work, "one/two/result.txt"), "utf8")).toBe(
      "committed",
    );
    expectHandlesReleased();
  });

  test("a failed commit does not report output and closes root and parent", async () => {
    await mkdir(join(work, "one/two"), { recursive: true });
    await writeFile(join(work, "one/two/result.txt"), "existing");
    const onCommitted = vi.fn();
    await expect(
      atomicWriteText({
        target: target("one/two/result.txt"),
        content: "replacement",
        expectedVersion: { kind: "absent" },
        onCommitted,
      }),
    ).rejects.toThrow();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await readFile(join(work, "one/two/result.txt"), "utf8")).toBe(
      "existing",
    );
    expectHandlesReleased();
  });

  test("failed nested traversal closes the retained root without reporting", async () => {
    await mkdir(join(work, "one"));
    await writeFile(join(work, "one/blocker"), "not a directory");
    const output = target("one/result.txt");
    const onCommitted = vi.fn();
    await expect(
      atomicWriteText({
        target: {
          ...output,
          absolutePath: join(work, "one/blocker/result.txt"),
          relativePath: "one/blocker/result.txt",
          logicalPath: "one/blocker/result.txt",
        },
        content: "content",
        expectedVersion: { kind: "absent" },
        onCommitted,
      }),
    ).rejects.toThrow();
    expect(onCommitted).not.toHaveBeenCalled();
    expectHandlesReleased();
  });
});
