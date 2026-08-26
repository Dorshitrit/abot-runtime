import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WORKSPACE_SUMMARY_FILE } from "../config/layout.js";
import {
  createDefaultConversationContextProvider,
  createDefaultEventSinkFactory,
  createDefaultModelGatewayClient,
  createDefaultSessionStore,
  createDefaultSkillProvider,
  createDefaultToolRegistry,
  createDefaultWorkspaceProvider,
  createCompiledWorkspaceProvider,
  createFileSessionStore,
  createInMemorySessionStore,
  createMultiWorkspaceProvider,
  createNoopEventSink,
  createSourceWorkspaceProvider,
  resetDebugLoggerConfig,
} from "../index.js";
import type { RuntimeConfig } from "../index.js";
import { processDebugLogger } from "../observability/debug-logger.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await processDebugLogger.drain();
  resetDebugLoggerConfig();
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

async function createConfiguredRuntimeRoot(): Promise<{
  rootDir: string;
  config: RuntimeConfig;
}> {
  const rootDir = join(tmpdir(), `llm-runtime-ports-${randomUUID()}`);
  tempRoots.push(rootDir);

  await mkdir(join(rootDir, "compiled"), { recursive: true });
  await mkdir(join(rootDir, "sessions"), { recursive: true });
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await mkdir(join(rootDir, "logs"), { recursive: true });
  await mkdir(join(rootDir, ".runtime"), { recursive: true });

  return {
    rootDir,
    config: {
      runtimeId: "test",
      agentBridgeUrl: "ws://test",
      modelGatewayUrl: "http://model",
      requestRunner: {
        configPath: join(rootDir, "request-runner.config.json"),
      },
      paths: {
        rootDir,
        runtimeDir: join(rootDir, ".runtime"),
        agentWorkDir: join(rootDir, "sandbox"),
        sessionsDir: join(rootDir, "sessions"),
        attachmentsDir: join(rootDir, "attachments"),
        workspaceDir: join(rootDir, "workspace"),
        sharedDir: join(rootDir, "shared"),
        compiledDir: join(rootDir, "compiled"),
        traceFile: join(rootDir, "logs", "runtime-debug.jsonl"),
      },
    },
  };
}

describe("runtime public ports", () => {
  test("default tool registry exposes current tool definitions", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.hasToolsAvailable()).toBe(true);
    expect(registry.getDefinition("write_file")?.name).toBe("write_file");
    expect(registry.listDefinitions().map((tool) => tool.name)).toContain(
      "read_file",
    );
  });

  test("configured tool registry applies plugin allow and deny selection", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    config.paths.rootDir = process.cwd();
    config.plugins = {
      enabled: true,
      allow: ["filesystem"],
      deny: ["filesystem.read_file"],
    };

    const registry = createDefaultToolRegistry(config);
    const toolNames = registry.listDefinitions().map((tool) => tool.name);

    expect(toolNames).toContain("write_file");
    expect(toolNames).not.toContain("read_file");
    expect(registry.getDefinition("write_file")?.name).toBe("write_file");
    expect(registry.getDefinition("read_file")).toBeUndefined();
  });

  test("configured tool registry can disable the plugin catalog", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    config.paths.rootDir = process.cwd();
    config.plugins = { enabled: false };

    const registry = createDefaultToolRegistry(config);

    expect(registry.hasToolsAvailable()).toBe(false);
    expect(registry.listDefinitions()).toEqual([]);
    expect(registry.getImplementations()).toEqual({});
  });

  test("configured tool registry prepares current runtime paths for capabilities", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    const registry = createDefaultToolRegistry(config);
    const sharedState = {
      currentSessionId: "session-1",
    };
    const prepared = registry.prepareSharedState?.(sharedState);

    expect(prepared).not.toBe(sharedState);
    expect(prepared).toMatchObject({
      currentSessionId: "session-1",
      runtimePaths: {
        rootDir: config.paths.rootDir,
        runtimeDir: config.paths.runtimeDir,
        agentWorkDir: config.paths.agentWorkDir,
        sessionsDir: config.paths.sessionsDir,
        workspaceDir: config.paths.workspaceDir,
        sharedDir: config.paths.sharedDir,
        compiledDir: config.paths.compiledDir,
        traceFile: config.paths.traceFile,
      },
    });
  });

  test("default skill and workspace providers expose current context loaders", async () => {
    const skillProvider = createDefaultSkillProvider();
    const workspaceProvider = createDefaultWorkspaceProvider();

    await expect(
      skillProvider.getActionContext("inspect_project"),
    ).resolves.toContain("Project Orientation Skill");
    await expect(workspaceProvider.getSystemSummary()).resolves.toEqual(
      expect.any(String),
    );
  });

  test("workspace provider loads workspace source from configured workspace path", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    await writeFile(
      join(config.paths.workspaceDir, "AGENT.md"),
      "# Agent\n\nCustom configured workspace source",
    );

    const workspaceProvider = createDefaultWorkspaceProvider(config);

    await expect(workspaceProvider.getSystemSummary()).resolves.toContain(
      "Custom configured workspace source",
    );
  });

  test("source workspace provider loads markdown through the public port", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    await writeFile(
      join(config.paths.workspaceDir, "USER.md"),
      "# User\n\nPublic source workspace summary",
    );

    const workspaceProvider = createSourceWorkspaceProvider({
      workspaceDir: config.paths.workspaceDir,
    });

    await expect(workspaceProvider.getSystemSummary()).resolves.toContain(
      "Public source workspace summary",
    );
  });

  test("compiled workspace provider loads summary through the public port", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    const compiledPath = join(
      config.paths.compiledDir,
      "custom-workspace-summary.json",
    );
    await writeFile(
      compiledPath,
      JSON.stringify({
        summary: "Public compiled workspace summary",
      }),
    );

    const workspaceProvider = createCompiledWorkspaceProvider({
      compiledPath,
    });

    await expect(workspaceProvider.getSystemSummary()).resolves.toContain(
      "Public compiled workspace summary",
    );
  });

  test("multi-workspace provider routes to configured workspace providers", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    const firstPath = join(config.paths.compiledDir, "workspace-a.json");
    const secondPath = join(config.paths.compiledDir, "workspace-b.json");
    await Promise.all([
      writeFile(firstPath, JSON.stringify({ summary: "Workspace A summary" })),
      writeFile(secondPath, JSON.stringify({ summary: "Workspace B summary" })),
    ]);

    let activeWorkspace = "a";
    const provider = createMultiWorkspaceProvider({
      defaultWorkspace: "a",
      resolveWorkspace: () => activeWorkspace,
      workspaces: {
        a: createCompiledWorkspaceProvider({ compiledPath: firstPath }),
        b: createCompiledWorkspaceProvider({ compiledPath: secondPath }),
      },
    });

    await expect(provider.getSystemSummary()).resolves.toContain(
      "Workspace A summary",
    );
    activeWorkspace = "b";
    await expect(provider.getSystemSummary()).resolves.toContain(
      "Workspace B summary",
    );
    activeWorkspace = "missing";
    await expect(provider.getSystemSummary()).resolves.toContain(
      "Workspace A summary",
    );
  });

  test("file session store persists through the public SessionStore port", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    const store = createFileSessionStore({
      sessionsDir: config.paths.sessionsDir,
      now: () => new Date("2026-05-10T00:00:00.000Z"),
      createMessageId: () => "msg-public-file-store",
    });

    await store.appendMessage("file-store-session", "user", "hello", {
      lastAgentMode: "reasoning",
    });

    await expect(
      store.getSessionById("file-store-session"),
    ).resolves.toMatchObject({
      id: "file-store-session",
      messageCount: 1,
      messages: [
        {
          id: "msg-public-file-store",
          role: "user",
          content: "hello",
        },
      ],
    });
  });

  test("in-memory session store satisfies the public SessionStore port", async () => {
    let tick = 0;
    const store = createInMemorySessionStore({
      now: () =>
        new Date(`2026-05-10T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await store.appendMessage("memory-session", "user", "Question");
    await store.appendMessage("memory-session", "assistant", "Answer", {
      requestId: "req-memory",
      source: "request",
    });
    await store.startRequestStream("memory-session", "req-memory");
    await store.appendRequestEvent("memory-session", "req-memory", {
      type: "event",
      requestId: "req-memory",
      name: "thinking.delta",
      text: "first",
    });
    await store.appendRequestEvent("memory-session", "req-memory", {
      type: "event",
      requestId: "req-memory",
      name: "thinking.delta",
      text: "latest",
    });
    await store.appendRequestEvent("memory-session", "req-memory", {
      type: "completed",
      requestId: "req-memory",
      output: "Answer",
    });
    await store.appendContextEntry?.("memory-session", {
      kind: "tool_observation",
      content: "Hidden request handoff",
      observationMeta: {
        kind: "task_result",
        carryPolicy: "always",
      },
      requestId: "req-memory",
    });

    await expect(store.getSessionById("memory-session")).resolves.toMatchObject(
      {
        id: "memory-session",
        messageCount: 2,
        requests: [
          {
            requestId: "req-memory",
            status: "completed",
            lastSeqNo: 3,
          },
        ],
      },
    );

    await expect(
      store.getSessionSnapshot("memory-session", {
        afterMessageId: 1,
        includeRequests: true,
      }),
    ).resolves.toMatchObject({
      sessionId: "memory-session",
      messages: [
        {
          id: 2,
          role: "assistant",
          text: "Answer",
          requestId: "req-memory",
        },
      ],
      requests: [
        {
          requestId: "req-memory",
          status: "completed",
          finalState: {
            status: "completed",
            output: "Answer",
          },
        },
      ],
    });

    await expect(
      store.getRequestReplayById("req-memory", 1),
    ).resolves.toMatchObject({
      requestId: "req-memory",
      sessionId: "memory-session",
      events: [
        {
          type: "event",
          requestId: "req-memory",
          seqNo: 2,
          name: "thinking.delta",
          text: "latest",
        },
        {
          type: "completed",
          requestId: "req-memory",
          seqNo: 3,
          output: "Answer",
        },
      ],
      finalState: {
        status: "completed",
        output: "Answer",
      },
    });

    await expect(
      store.deleteMessageWithStats("memory-session", "2"),
    ).resolves.toMatchObject({
      sessionId: "memory-session",
      messageId: "2",
      deleted: true,
      deletedRequestId: "req-memory",
      deletedRequestEvents: 2,
    });
    await expect(store.getSessionById("memory-session")).resolves.toMatchObject(
      {
        contextEntries: [],
        requests: [],
      },
    );
  });

  test("default session store is backed by the configured file session store", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    const store = createDefaultSessionStore(config);

    await store.appendMessage("configured-session", "assistant", "saved");

    const raw = await readFile(
      join(config.paths.sessionsDir, "configured-session.json"),
      "utf-8",
    );
    const persisted = JSON.parse(raw) as {
      id: string;
      messageCount: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(persisted).toMatchObject({
      id: "configured-session",
      messageCount: 1,
      messages: [
        {
          role: "assistant",
          content: "saved",
        },
      ],
    });
  });

  test("model gateway client uses configured gateway URL", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    config.modelGatewayUrl = "http://configured-runtime-gateway.test/";
    config.models = {
      profiles: {
        "local-chat": {
          model: "local-chat:model",
        },
      },
      defaults: {
        profileId: "local-chat",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({
                type: "done",
                data: { text: "ok" },
              })}\n`,
            ),
          );
          controller.close();
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createDefaultModelGatewayClient(config);
    await client.invoke({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://configured-runtime-gateway.test/chat",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(
      expect.objectContaining({
        modelPolicy: config.models,
      }),
    );
  });

  test("event sink keeps client content while tracing only event metadata", async () => {
    const { config } = await createConfiguredRuntimeRoot();
    config.paths.traceFile = join(config.paths.rootDir, "logs", "events.jsonl");
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };
    const factory = createDefaultEventSinkFactory(config);
    const sink = factory.create({
      requestId: "req-trace",
      ws: ws as never,
    });

    sink.event("planner.plan.item.started", {
      stage: "development_plan",
      phase: "started",
      plan: {
        summary: "PRIVATE_TRACE_PLAN_SUMMARY",
        total: 1,
        completed: 0,
        items: [
          {
            title: "PRIVATE_TRACE_ITEM_TITLE",
            status: "in_progress",
          },
        ],
      },
      item: {
        title: "PRIVATE_TRACE_ITEM_TITLE",
        status: "in_progress",
      },
    });

    await processDebugLogger.drain();
    const raw = await readFile(config.paths.traceFile, "utf-8");
    const parsedLines = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("PRIVATE_TRACE_PLAN_SUMMARY");
    expect(JSON.stringify(sent[0])).toContain("PRIVATE_TRACE_ITEM_TITLE");
    expect(raw).not.toContain("PRIVATE_TRACE_PLAN_SUMMARY");
    expect(raw).not.toContain("PRIVATE_TRACE_ITEM_TITLE");
    expect(parsedLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.emitter",
          event: "ui.event.emit",
          requestId: "req-trace",
          rawName: "planner.plan.item.started",
          emittedNameChanged: true,
          eventSequence: 1,
          stage: "development_plan",
          phase: "started",
          payloadFieldCount: 8,
        }),
      ]),
    );
  });

  test("conversation provider preserves existing session context behavior", () => {
    const provider = createDefaultConversationContextProvider();
    const session = {
      id: "test-session",
      title: "test-session",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "msg-1",
          role: "user" as const,
          content: "hello",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
        {
          id: "msg-2",
          role: "assistant" as const,
          content: "hi",
          createdAt: "2026-05-09T00:00:01.000Z",
        },
      ],
    };

    expect(provider.buildContextWindow(session)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("noop event sink satisfies the public event sink contract", async () => {
    const sink = createNoopEventSink();

    sink.publish({ type: "event", name: "test" });
    sink.event("runtime.state", { stage: "test" });
    sink.runtimeState({ stage: "test", phase: "started" });
    sink.token("token");
    sink.legacyToken("legacy");
    sink.thinkingDelta("delta", "delta");
    sink.completed("done");
    sink.failed("failed");
    await expect(sink.drain()).resolves.toBeUndefined();
    expect(() => sink.dispose()).not.toThrow();
  });
});
