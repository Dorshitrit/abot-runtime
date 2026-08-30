import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_MUTATION_BYTES,
  readBoundedText,
  readExactBytes,
} from "../../../plugins/filesystem/source/bounded-io.js";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import type {
  RuntimePluginLoadContext,
  ToolExecutionContext,
} from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

const temporaryRoots: string[] = [];

type Fixture = Awaited<ReturnType<typeof createFixture>>;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "filesystem-mutation-safety-"));
  temporaryRoots.push(root);
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: join(root, "agent-work"),
    sessionsDir: join(root, ".runtime", "sessions"),
    attachmentsDir: join(root, ".runtime", "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, ".runtime", "shared"),
    compiledDir: join(root, ".runtime", "compiled"),
    traceFile: join(root, ".runtime", "trace.jsonl"),
  };
  await Promise.all(
    [
      runtimePaths.runtimeDir,
      runtimePaths.agentWorkDir,
      runtimePaths.sessionsDir,
      runtimePaths.attachmentsDir,
      runtimePaths.workspaceDir,
      runtimePaths.sharedDir,
      runtimePaths.compiledDir,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  const runtimePathResolver = createRuntimeToolPathResolver(runtimePaths);
  const loadContext = {
    id: "filesystem",
    path: join(process.cwd(), "plugins", "filesystem"),
    pluginRoot: join(process.cwd(), "plugins", "filesystem"),
    stateDir: join(runtimePaths.runtimeDir, "plugins", "filesystem"),
    rootDir: root,
    runtimeId: "filesystem-mutation-safety",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver,
  } satisfies RuntimePluginLoadContext & Readonly<{ pluginRoot: string }>;
  return { root, runtimePaths, loadContext, runtimePathResolver };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function repairResponse(replacement: string): string {
  return JSON.stringify({
    placement: "replace",
    start_line: 1,
    end_line: 1,
    replacement,
  });
}

function delayedRepair(
  entered: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
  response: string,
): ToolExecutionContext {
  return {
    modelInvoker: {
      async invokeText() {
        entered.resolve();
        await release.promise;
        return response;
      },
    },
  };
}

async function expectNoTemporaryMutationFiles(fixture: Fixture): Promise<void> {
  await expect(readdir(fixture.runtimePaths.agentWorkDir)).resolves.not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^\.abot-/u)]),
  );
}

describe("filesystem mutation safety", () => {
  test("loops over short positional reads and rejects premature EOF", async () => {
    const source = Buffer.from("short-read-completed", "utf8");
    let calls = 0;
    const reader = {
      async read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) {
        calls += 1;
        const bytesRead = Math.min(3, length, source.length - position);
        if (bytesRead > 0) {
          source.copy(buffer, offset, position, position + bytesRead);
        }
        return { bytesRead };
      },
    };
    const target = Buffer.alloc(source.length);

    await readExactBytes(reader, target, 0, "sample.txt");

    expect(target.equals(source)).toBe(true);
    expect(calls).toBeGreaterThan(1);
    await expect(
      readExactBytes(
        { read: async () => ({ bytesRead: 0 }) },
        Buffer.alloc(1),
        0,
        "sample.txt",
      ),
    ).rejects.toMatchObject({ code: "filesystem_read_incomplete" });
  });

  test("serializes write and edit across plugin instances for one target", async () => {
    const fixture = await createFixture();
    const first = createFilesystemPlugin(fixture.loadContext);
    const second = createFilesystemPlugin(fixture.loadContext);
    const target = join(fixture.runtimePaths.agentWorkDir, "shared.js");
    await writeFile(target, "const base = true;", "utf8");
    const entered = deferred();
    const release = deferred();
    const write = first.handlers.write_file!(
      {
        path: "shared.js",
        content: "const base = true;\nconst fromWrite = ;",
      },
      delayedRepair(
        entered,
        release,
        JSON.stringify({
          placement: "replace",
          start_line: 2,
          end_line: 2,
          replacement: "const fromWrite = true;",
        }),
      ),
    );
    await entered.promise;
    const edit = second.handlers.edit_file!({
      path: "shared.js",
      instruction: "Set base to false.",
      selection: JSON.stringify({
        placement: "replace",
        start_line: 1,
        end_line: 1,
      }),
      content: "const base = false;",
    });

    release.resolve();
    const [writeResult, editResult] = await Promise.all([write, edit]);

    expect(writeResult).toMatchObject({ ok: true });
    expect(editResult).toMatchObject({ ok: true });
    await expect(readFile(target, "utf8")).resolves.toBe(
      "const base = false;\nconst fromWrite = true;",
    );
  });

  test("preserves an externally changed existing target", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);
    const target = join(fixture.runtimePaths.agentWorkDir, "existing.json");
    await writeFile(target, '{"before":true}', "utf8");
    const entered = deferred();
    const release = deferred();
    const pending = plugin.handlers.write_file!(
      { path: "existing.json", content: '{"after":}' },
      delayedRepair(entered, release, repairResponse('{"after":true}')),
    );
    await entered.promise;
    await writeFile(target, '{"external":true}', "utf8");
    release.resolve();

    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      errorCode: "filesystem_target_changed",
    });
    expect(result.output).toContain("existing.json");
    expect(result.output).not.toContain(fixture.root);
    await expect(readFile(target, "utf8")).resolves.toBe('{"external":true}');
    await expectNoTemporaryMutationFiles(fixture);
  });

  test("rejects invalid UTF-8 before editing and preserves the exact bytes", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);
    const target = join(fixture.runtimePaths.agentWorkDir, "invalid-utf8.txt");
    const original = Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a, 0x62]);
    await writeFile(target, original);

    const result = await plugin.handlers.edit_file!({
      path: "invalid-utf8.txt",
      instruction: "Replace the first line.",
      selection: JSON.stringify({
        placement: "replace",
        start_line: 1,
        end_line: 1,
      }),
      content: "updated",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "filesystem_invalid_encoding",
    });
    expect(result.output).toContain("invalid-utf8.txt");
    expect(result.output).not.toContain(fixture.root);
    await expect(readFile(target)).resolves.toEqual(original);
    await expectNoTemporaryMutationFiles(fixture);
  });

  test("preserves a target created externally after an absent read", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);
    const target = join(fixture.runtimePaths.agentWorkDir, "created.json");
    const entered = deferred();
    const release = deferred();
    const pending = plugin.handlers.write_file!(
      { path: "created.json", content: '{"planned":}' },
      delayedRepair(entered, release, repairResponse('{"planned":true}')),
    );
    await entered.promise;
    await writeFile(target, '{"external":true}', "utf8");
    release.resolve();

    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      errorCode: "filesystem_target_changed",
    });
    await expect(readFile(target, "utf8")).resolves.toBe('{"external":true}');
    await expectNoTemporaryMutationFiles(fixture);
  });

  test("rejects repaired content above the mutation limit before writing", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);
    const prefix = '{"value":"';
    const candidate = `${prefix}${"a".repeat(
      MAX_MUTATION_BYTES - Buffer.byteLength(prefix, "utf8"),
    )}`;
    expect(Buffer.byteLength(candidate, "utf8")).toBe(MAX_MUTATION_BYTES);
    const oversized = `{"value":"${"b".repeat(MAX_MUTATION_BYTES)}"}`;
    const invokeText = vi.fn(async () => repairResponse(oversized));

    const result = await plugin.handlers.write_file!(
      { path: "oversized.json", content: candidate },
      { modelInvoker: { invokeText } },
    );

    expect(invokeText).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, errorCode: "file_too_large" });
    await expect(
      stat(join(fixture.runtimePaths.agentWorkDir, "oversized.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTemporaryMutationFiles(fixture);
  });

  test("prepares bounded mutation evidence before committing control-rich text", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);
    const content = `prefix-${"\u0001".repeat(30_000)}-suffix`;

    const result = await plugin.handlers.write_file!({
      path: "control-rich.txt",
      content,
    });

    expect(result).toMatchObject({ ok: true });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      128 * 1024,
    );
    await expect(
      readFile(
        join(fixture.runtimePaths.agentWorkDir, "control-rich.txt"),
        "utf8",
      ),
    ).resolves.toBe(content);
  });

  test("creates missing parent directories through anchored descriptors", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);

    const result = await plugin.handlers.write_file!({
      path: "nested/child/created.txt",
      content: "anchored",
    });

    expect(result).toMatchObject({ ok: true });
    await expect(
      readFile(
        join(
          fixture.runtimePaths.agentWorkDir,
          "nested",
          "child",
          "created.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("anchored");
  });

  test("does not follow an intermediate directory swapped after resolution", async () => {
    const fixture = await createFixture();
    const plugin = createFilesystemPlugin(fixture.loadContext);
    const safeDirectory = join(fixture.runtimePaths.agentWorkDir, "safe");
    const originalDirectory = join(
      fixture.runtimePaths.agentWorkDir,
      "safe-original",
    );
    const outsideDirectory = join(fixture.root, "outside");
    await Promise.all([mkdir(safeDirectory), mkdir(outsideDirectory)]);
    const entered = deferred();
    const release = deferred();
    const pending = plugin.handlers.write_file!(
      { path: "safe/target.json", content: '{"safe":}' },
      delayedRepair(entered, release, repairResponse('{"safe":true}')),
    );
    await entered.promise;
    await rename(safeDirectory, originalDirectory);
    await symlink(outsideDirectory, safeDirectory, "dir");
    release.resolve();

    const result = await pending;

    expect(result).toMatchObject({ ok: false });
    await expect(
      stat(join(outsideDirectory, "target.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a resolved read redirected through an intermediate symlink", async () => {
    const fixture = await createFixture();
    const safeDirectory = join(fixture.runtimePaths.agentWorkDir, "read-safe");
    const originalDirectory = join(
      fixture.runtimePaths.agentWorkDir,
      "read-safe-original",
    );
    const outsideDirectory = join(fixture.root, "read-outside");
    await Promise.all([mkdir(safeDirectory), mkdir(outsideDirectory)]);
    await writeFile(join(safeDirectory, "target.txt"), "inside", "utf8");
    await writeFile(join(outsideDirectory, "target.txt"), "outside", "utf8");
    const target = fixture.runtimePathResolver.resolve("read-safe/target.txt", {
      requirePath: true,
      allowedLocations: ["agent_work"],
    });
    await rename(safeDirectory, originalDirectory);
    await symlink(outsideDirectory, safeDirectory, "dir");

    await expect(readBoundedText(target)).rejects.toMatchObject({
      code: "filesystem_path_changed",
    });
  });
});
