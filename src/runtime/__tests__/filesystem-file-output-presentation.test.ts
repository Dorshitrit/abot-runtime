import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { executeToolCall } from "../../capabilities/tool-executor.js";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { createFilesystemPathService } from "../../../plugins/filesystem/source/path-service.js";
import { getProcessFilesystemMutationCoordinator } from "../../../plugins/filesystem/source/mutation-coordinator.js";
import { createWriteFileHandler } from "../../../plugins/filesystem/source/write-file.js";
import { createEditFileHandler } from "../../../plugins/filesystem/source/edit-file.js";
import type { ToolFileOutputReport } from "../../capabilities/file-output-presentation.js";

const rootIdentity = vi.hoisted(() => ({ available: true }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const stats = actual.statSync(...args);
      if (rootIdentity.available) return stats;
      if (!stats) return stats;
      return Object.assign(stats, { birthtimeNs: 0n });
    },
  };
});

const registration: RegisteredToolNormalInvocation = {
  toolName: "write_file",
  definition: {
    name: "write_file",
    routingCapability: "filesystem_mutation",
    executionEffect: "mutating",
    params: { path: "string", content: "string" },
    eventPresentation: {
      metadata: { path: { param: "path", kind: "string" } },
    },
  },
  contract: {
    version: 1,
    operations: [
      {
        operationId: "write_file",
        summary: "Write a file.",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            content: { type: "string", minLength: 1, maxLength: 4096 },
          },
          required: ["path", "content"],
        },
        effect: "mutating",
        approval: "request_policy",
      },
    ],
  },
};

describe("filesystem output presentation boundary", () => {
  let root = "";
  let agentWorkDir = "";
  let workspaceDir = "";

  beforeEach(async () => {
    const artifacts = path.join(process.cwd(), ".codex", "artifacts");
    await mkdir(artifacts, { recursive: true });
    root = await mkdtemp(path.join(artifacts, "file-output-source-test-"));
    agentWorkDir = path.join(root, "agent-work");
    workspaceDir = path.join(root, "workspace-source");
    await Promise.all([mkdir(agentWorkDir), mkdir(workspaceDir)]);
    vi.stubEnv("LLM_RUNTIME_TRACE", "0");
  });

  afterEach(async () => {
    rootIdentity.available = true;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function fixture() {
    const runtimePaths = { rootDir: root, agentWorkDir, workspaceDir };
    const resolver = createRuntimeToolPathResolver(runtimePaths);
    const write = createWriteFileHandler(
      createFilesystemPathService(resolver),
      getProcessFilesystemMutationCoordinator(),
    );
    const events: Record<string, unknown>[] = [];
    const executor = createRegisteredToolNormalInvocationExecutor({
      registrations: [registration],
      requestId: "request-files",
      sharedState: { runtimePaths },
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "unused",
      onEvent: (name, payload) => events.push({ name, ...payload }),
      toolRegistry: {
        execute: (call, options) =>
          executeToolCall(call, {
            ...options,
            runtimePathResolver: resolver,
            implementations: { write_file: write },
          }),
      },
    });
    return {
      events,
      resolver,
      write,
      run: (target: string, content: string) => {
        const prepared = executor.prepare({
          handle: executor.operations[0]!.handle,
          controls: { path: target, content },
        });
        if (prepared.status !== "prepared") return Promise.resolve(prepared);
        return prepared.execute("execution-files");
      },
    };
  }

  test("publishes a successful write origin without adding it to the tool result", async () => {
    const { run, events } = fixture();
    const result = await run("notes.txt", "hello");
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("execution rejected");
    expect(result.result.ok).toBe(true);
    expect(await readFile(path.join(agentWorkDir, "notes.txt"), "utf8")).toBe(
      "hello",
    );
    const completed = events.find((event) => event.name === "tool.completed");
    expect(completed).toMatchObject({
      executionId: "execution-files",
      ok: true,
      meta: {
        fileOutput: {
          version: 1,
          location: "agent_work",
          rootId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          relativePath: "notes.txt",
          logicalPath: "notes.txt",
          operation: "created",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fileOutput");
    expect(JSON.stringify(completed)).not.toContain(agentWorkDir);
  });

  test("does not publish a new output for unchanged or failed writes", async () => {
    const { run, events } = fixture();
    await run("notes.txt", "hello");
    events.length = 0;
    await run("notes.txt", "hello");
    const failed = await run("../outside.txt", "hello");
    expect(failed).toMatchObject({ status: "executed", result: { ok: false } });
    for (const completed of events.filter(
      (event) => event.name === "tool.completed",
    )) {
      expect(completed.meta).not.toHaveProperty("fileOutput");
    }
  });

  test("preserves source location for two paths with the same logical display", async () => {
    const { run, events } = fixture();
    await mkdir(path.join(agentWorkDir, "workspace"));
    await run(path.join(agentWorkDir, "workspace", "notes.txt"), "agent file");
    await run("workspace/notes.txt", "workspace file");
    const completed = events.filter((event) => event.name === "tool.completed");
    expect(completed[0]).toMatchObject({
      meta: {
        fileOutput: {
          location: "agent_work",
          relativePath: "workspace/notes.txt",
        },
      },
    });
    expect(completed[1]).toMatchObject({
      meta: {
        fileOutput: {
          location: "workspace",
          relativePath: "notes.txt",
        },
      },
    });
    expect(completed[0]?.meta).not.toEqual(completed[1]?.meta);
  });

  test("reports replacement writes as updates", async () => {
    const { run, events } = fixture();
    await run("notes.txt", "before");
    events.length = 0;
    await run("notes.txt", "after");
    expect(
      events.find((event) => event.name === "tool.completed"),
    ).toMatchObject({ meta: { fileOutput: { operation: "updated" } } });
  });

  test("binds a new successful write to the replacement root instance", async () => {
    const { run, events } = fixture();
    const first = await run("notes.txt", "hello");
    const before = events.find((event) => event.name === "tool.completed");
    await rename(agentWorkDir, agentWorkDir + "-previous");
    await mkdir(agentWorkDir);
    events.length = 0;
    const second = await run("notes.txt", "hello");
    const after = events.find((event) => event.name === "tool.completed");
    expect(second).toEqual(first);
    expect(after?.meta).not.toEqual(before?.meta);
    expect(JSON.stringify(second)).not.toContain("fileOutput");
  });

  test("retains mutation success when stable root identity is unavailable", async () => {
    const { run, events } = fixture();
    const baseline = await run("notes.txt", "hello");
    await rm(path.join(agentWorkDir, "notes.txt"));
    events.length = 0;
    rootIdentity.available = false;
    const result = await run("notes.txt", "hello");
    expect(result).toEqual(baseline);
    expect(await readFile(path.join(agentWorkDir, "notes.txt"), "utf8")).toBe(
      "hello",
    );
    const completed = events.find((event) => event.name === "tool.completed");
    expect(completed).toMatchObject({ ok: true });
    expect(completed?.meta).not.toHaveProperty("fileOutput");
  });

  test("retains the exact source when the activity target is truncated", async () => {
    const { run, events } = fixture();
    const target = `${Array.from({ length: 6 }, (_, index) => `${index}-${"a".repeat(90)}`).join("/")}/notes.txt`;
    await run(target, "hello");
    const completed = events.find((event) => event.name === "tool.completed");
    expect(completed).toMatchObject({
      meta: {
        fileOutput: {
          relativePath: target,
          logicalPath: target,
        },
      },
    });
    expect(completed?.actions).toEqual([
      { type: "establish_target", target: `${target.slice(0, 497)}...` },
    ]);
  });

  test("does not change committed write outcomes when a presentation callback throws", async () => {
    const { write, resolver } = fixture();
    const call = {
      tool: "write_file",
      params: { path: "notes.txt", content: "hello" },
    };
    const options = {
      runtimePathResolver: resolver,
      implementations: { write_file: write },
    };
    const baseline = await executeToolCall(call, options);
    await rm(path.join(agentWorkDir, "notes.txt"));
    const callback = vi.fn(() => {
      throw new Error("presentation unavailable");
    });
    const withPresentation = await executeToolCall(call, {
      ...options,
      reportFileOutput: callback,
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(withPresentation).toEqual(baseline);
    expect(await readFile(path.join(agentWorkDir, "notes.txt"), "utf8")).toBe(
      "hello",
    );
  });

  test("reports successful edits with the exact resolved source and omits unchanged edits", async () => {
    const { run, resolver } = fixture();
    await run("notes.txt", "before");
    const edit = createEditFileHandler(
      createFilesystemPathService(resolver),
      getProcessFilesystemMutationCoordinator(),
    );
    const reports: ToolFileOutputReport[] = [];
    const call = {
      tool: "edit_file",
      params: {
        path: "notes.txt",
        instruction: "Replace the first line.",
        selection: JSON.stringify({
          placement: "replace",
          start_line: 1,
          end_line: 1,
        }),
        content: "after",
      },
    };
    const options = {
      runtimePathResolver: resolver,
      implementations: { edit_file: edit },
      reportFileOutput: (report: ToolFileOutputReport) => reports.push(report),
    };
    const edited = await executeToolCall(call, options);
    expect(edited.ok).toBe(true);
    const root = statSync(agentWorkDir, { bigint: true });
    expect(reports).toEqual([
      {
        target: resolver.resolve("notes.txt"),
        operation: "updated",
        rootIdentity: {
          device: String(root.dev),
          inode: String(root.ino),
          birthtimeNs: String(root.birthtimeNs),
        },
      },
    ]);
    expect(await readFile(path.join(agentWorkDir, "notes.txt"), "utf8")).toBe(
      "after",
    );
    reports.length = 0;
    const unchanged = await executeToolCall(call, options);
    expect(unchanged.ok).toBe(true);
    expect(reports).toEqual([]);
  });

  test("an edit remains successful if its presentation reporter fails", async () => {
    const { run, resolver } = fixture();
    await run("notes.txt", "before");
    const edit = createEditFileHandler(
      createFilesystemPathService(resolver),
      getProcessFilesystemMutationCoordinator(),
    );
    const result = await executeToolCall(
      {
        tool: "edit_file",
        params: {
          path: "notes.txt",
          instruction: "Replace the first line.",
          selection: JSON.stringify({
            placement: "replace",
            start_line: 1,
            end_line: 1,
          }),
          content: "after",
        },
      },
      {
        runtimePathResolver: resolver,
        implementations: { edit_file: edit },
        reportFileOutput: () => {
          throw new Error("presentation unavailable");
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(agentWorkDir, "notes.txt"), "utf8")).toBe(
      "after",
    );
  });
});
