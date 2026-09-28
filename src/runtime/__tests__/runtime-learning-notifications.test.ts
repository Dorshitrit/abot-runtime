import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimeEnvironment } from "../runtime-environment.js";
import { createRuntimePassiveLearning } from "../adapters/passive-learning-runtime.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { processDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { PassiveLearningService } from "../passive-learning/contracts.js";
import type { RuntimeConfig } from "../ports.js";

vi.mock("../adapters/scheduler-runtime.js", () => ({ createRuntimeScheduler: () => ({
  scheduler: {}, start: vi.fn(), stop: vi.fn(), subscribe: vi.fn(),
}) }));
vi.mock("../adapters/passive-learning-runtime.js", () => ({ createRuntimePassiveLearning: vi.fn() }));

const environments: { environment: ReturnType<typeof createRuntimeEnvironment>; rootDir: string }[] = [];
afterEach(async () => {
  for (const { environment, rootDir } of environments.splice(0)) {
    try {
      await environment.stop();
    } finally {
      await processDebugLogger.drain();
      resetDebugLoggerConfig();
      await rm(rootDir, { recursive: true, force: true });
    }
  }
  vi.clearAllMocks();
});

async function fixture(injected = true) {
  const fixtureParent = join(process.cwd(), ".codex/artifacts/runtime-learning-notifications-tests");
  await mkdir(fixtureParent, { recursive: true });
  const rootDir = await mkdtemp(join(fixtureParent, "fixture-"));
  const config: RuntimeConfig = {
    runtimeId: "test", agentBridgeUrl: "ws://test", modelGatewayUrl: "http://model",
    paths: { rootDir, runtimeDir: rootDir, agentWorkDir: rootDir, sessionsDir: rootDir,
      attachmentsDir: rootDir, workspaceDir: rootDir, sharedDir: rootDir, compiledDir: rootDir,
      traceFile: join(rootDir, "debug.jsonl") },
    requestRunner: { configPath: join(rootDir, "request-runner.config.json") },
  };
  const memory = createLongTermMemoryService({ repository: createInMemoryLongTermMemoryRepository(), enabled: true,
    emitClientEvents: false, embeddings: { embed: async ({ texts }) => ({ modelFingerprint: "test", dimensions: 2,
      vectors: texts.map(() => [1, 0]) }) } });
  const subscribeChanges = vi.fn(memory.subscribeChanges!);
  const notifyKnowledgeChanged = vi.fn();
  const start = vi.fn(async () => {});
  const learning = { start, stop: vi.fn(async () => {}), notifyKnowledgeChanged } as unknown as PassiveLearningService;
  vi.mocked(createRuntimePassiveLearning).mockReturnValue(learning);
  const environment = createRuntimeEnvironment(config, {
    sessions: createInMemorySessionStore(), longTermMemory: { ...memory, subscribeChanges },
    ...(injected ? { passiveLearning: learning } : {}),
  });
  environments.push({ environment, rootDir });
  const save = (content: string) => memory.create({ content, tags: [], source: "web_ui",
    context: { abortSignal: new AbortController().signal } });
  return { environment, memory, start, notifyKnowledgeChanged, subscribeChanges, save };
}

describe("injected learning memory notifications", () => {
  it("delivers manual and background commits once, detaches on stop and reconnects on restart", async () => {
    const f = await fixture();
    await f.environment.start();
    await f.environment.start();
    expect(f.subscribeChanges).toHaveBeenCalledOnce();
    await f.save("Prefers concise explanations.");
    await f.memory.processCandidates({ candidates: [{ content: "Interested in music.", tags: [] }],
      context: { requestId: "request", sessionId: "session", abortSignal: new AbortController().signal } });
    expect(f.notifyKnowledgeChanged).toHaveBeenCalledTimes(2);
    await f.environment.stop();
    await f.save("Uses dark themes.");
    expect(f.notifyKnowledgeChanged).toHaveBeenCalledTimes(2);
    await f.environment.start();
    await f.save("Prefers keyboard navigation.");
    expect(f.notifyKnowledgeChanged).toHaveBeenCalledTimes(3);
  });

  it("detaches the listener if the injected service cannot start", async () => {
    const f = await fixture();
    f.start.mockRejectedValueOnce(new Error("startup failed"));
    await expect(f.environment.start()).rejects.toThrow("startup failed");
    await f.save("Prefers concise explanations.");
    expect(f.notifyKnowledgeChanged).not.toHaveBeenCalled();
    await f.environment.start();
    await f.save("Uses dark themes.");
    expect(f.notifyKnowledgeChanged).toHaveBeenCalledOnce();
  });

  it("leaves built-in subscription ownership with the built-in service", async () => {
    const f = await fixture(false);
    await f.environment.start();
    expect(f.subscribeChanges).not.toHaveBeenCalled();
  });
});
