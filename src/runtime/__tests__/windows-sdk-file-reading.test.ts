import { mkdir, writeFile, symlink, rename, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { readBoundedRegularFile } from "../../plugin-sdk/files.js";
import { runWindowsBoundedRead } from "../../plugin-sdk/files-windows/process.js";
import { decodeWindowsReadResult } from "../../plugin-sdk/files-windows/result.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);

async function fixture() {
  const context = await createPortablePluginFixture("filesystem");
  const root = context.runtimePaths.agentWorkDir;
  await mkdir(root, { recursive: true });
  return { root, context };
}

async function request(root: string, name: string) {
  const rootStats = await stat(root, { bigint: true });
  const fileStats = await stat(join(root, name), { bigint: true });
  const identity = (s: typeof rootStats) => ({
    device: String(s.dev), inode: String(s.ino), birthtimeNs: String(s.birthtimeNs),
  });
  return {
    rootPath: root, relativePath: name,
    rootIdentity: identity(rootStats), targetIdentity: identity(fileStats), maxBytes: "64",
  };
}

describe.skipIf(process.platform !== "win32")("Windows SDK bounded reading", () => {
  test.each([
    ["empty.txt", Buffer.alloc(0), 0],
    ["nested/שלום.txt", Buffer.from("שלום 🌍\nsecond line"), 64],
    ["binary.bin", Buffer.from([0, 255, 32, 128]), 4],
    ["document.bin", Buffer.alloc(10 * 1024 * 1024, 137), 10 * 1024 * 1024],
  ])("reads exact bytes for %s", async (name, bytes, maxBytes) => {
    const { root } = await fixture();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, name), bytes);
    const result = await readBoundedRegularFile(join(root, name), { rootPath: root, maxBytes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byteCount).toBe(bytes.length);
    expect(result.bytes.equals(bytes)).toBe(true);
  }, 20_000);

  test("rejects oversized files without returning partial content and preserves the file", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "file"), "retained");
    expect(await readBoundedRegularFile(join(root, "file"), { rootPath: root, maxBytes: 0 }))
      .toEqual({ ok: false, reason: "too_large", byteCount: 8 });
    expect(await readFile(join(root, "file"), "utf8")).toBe("retained");
    expect(await readBoundedRegularFile(root, { rootPath: root, maxBytes: 64 }))
      .toEqual({ ok: false, reason: "not_regular_file" });
  }, 15_000);

  test("rejects paths outside the root and junction redirects", async () => {
    const { root, context } = await fixture();
    const outside = join(context.rootDir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "not authorized");
    await symlink(outside, join(root, "redirect"), "junction");
    for (const file of [join(outside, "secret"), join(root, "redirect", "secret")]) {
      expect(await readBoundedRegularFile(file, { rootPath: root, maxBytes: 64 }))
        .toEqual({ ok: false, reason: "outside_root" });
    }
  });

  test("native traversal refuses a parent swapped for a junction after observation", async () => {
    const { root, context } = await fixture();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub/file"), "authorized");
    const captured = await request(root, "sub/file");
    const outside = join(context.rootDir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "file"), "private");
    await rename(join(root, "sub"), join(root, "held"));
    await symlink(outside, join(root, "sub"), "junction");
    const raw = await runWindowsBoundedRead(captured, 64);
    expect(decodeWindowsReadResult(raw, 64)).toEqual({ ok: false, reason: "changed_during_read" });
    expect(raw).not.toContain("private");
  }, 15_000);

  test.each(["root", "target"])("rejects replacement of the observed %s identity", async (which) => {
    const { root } = await fixture();
    await writeFile(join(root, "file"), "original");
    const captured = await request(root, "file");
    if (which === "target") {
      await rename(join(root, "file"), join(root, "held"));
      await writeFile(join(root, "file"), "replacement");
    } else {
      await rename(root, root + "-held");
      await mkdir(root);
      await writeFile(join(root, "file"), "replacement");
    }
    expect(decodeWindowsReadResult(await runWindowsBoundedRead(captured, 64), 64))
      .toEqual({ ok: false, reason: "changed_during_read" });
  }, 15_000);

  test("rejects a named stream instead of reading through a Windows alias", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "file"), "public");
    await writeFile(join(root, "file:private"), "private");
    const captured = await request(root, "file");
    captured.relativePath = "file:private";
    const raw = await runWindowsBoundedRead(captured, 64);
    expect(() => decodeWindowsReadResult(raw, 64)).toThrow("EIO");
    expect(raw).not.toContain("private");
  }, 15_000);

  test("actual constrained language blocks the read without bypassing policy", async () => {
    const constrained: typeof spawn = ((file: string, args: string[], options: object) =>
      spawn(file, [...args.slice(0, -1),
        "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';" + args.at(-1)], options)) as typeof spawn;
    const raw = await runWindowsBoundedRead({}, 64, undefined, constrained);
    expect(decodeWindowsReadResult(raw, 64)).toEqual({ ok: false, reason: "safe_open_unsupported" });
  }, 15_000);

  test("pre-aborted reads never access a missing target", async () => {
    const { root } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(readBoundedRegularFile(join(root, "missing"), {
      rootPath: root, maxBytes: 64, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
