import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createRuntimeEnvironment } from "../runtime-environment.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { RuntimeConfig } from "../ports.js";
import type { PassiveLearningService } from "../passive-learning/contracts.js";
import { processDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

test.each(["async failure", "sync failure", "success"])(
  "proposal cleanup %s does not invalidate committed session deletion", async (outcome) => {
    const parent = join(process.cwd(), ".codex/artifacts/co-worker-session-deletion-tests");
    await mkdir(parent, { recursive: true });
    const rootDir = await mkdtemp(join(parent, "fixture-"));
    const config: RuntimeConfig = {
      runtimeId: "test", agentBridgeUrl: "ws://test", modelGatewayUrl: "http://model",
      paths: { rootDir, runtimeDir: join(rootDir, "runtime"), agentWorkDir: join(rootDir, "sandbox"),
        sessionsDir: join(rootDir, "sessions"), attachmentsDir: join(rootDir, "attachments"),
        workspaceDir: join(rootDir, "workspace"), sharedDir: join(rootDir, "shared"),
        compiledDir: join(rootDir, "compiled"), traceFile: join(rootDir, "debug.jsonl") },
      requestRunner: { configPath: join(rootDir, "request-runner.config.json") },
    };
    const sessionDeleted = vi.fn(() => {
      if (outcome === "sync failure") throw new Error("private inaccessible proposal store");
      if (outcome === "async failure") return Promise.reject(new Error("private corrupt proposal store"));
      return Promise.resolve();
    });
    const sessions = createInMemorySessionStore();
    const environment = createRuntimeEnvironment(config, { sessions,
      passiveLearning: { sessionDeleted, stop: async () => {} } as unknown as PassiveLearningService });
    try {
      await environment.services.sessions.getOrCreateSession("conversation");
      await expect(environment.services.sessions.deleteSessionWithStats("conversation"))
        .resolves.toMatchObject({ sessionId: "conversation", deleted: true });
      expect(await sessions.getSessionById("conversation")).toBeNull();
      expect(sessionDeleted).toHaveBeenCalledExactlyOnceWith("conversation");
      await expect(environment.services.sessions.appendMessage("conversation", "assistant", "late"))
        .rejects.toMatchObject({ code: "session_deleted" });
    } finally {
      await environment.stop();
      await processDebugLogger.drain(); resetDebugLoggerConfig();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);
