import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelGatewayClient,
  RuntimeConfig,
  RuntimeHost,
  RuntimeHostHandle,
  RuntimeHostStartOptions,
} from "../../ports.js";
import { processDebugLogger } from "../../observability/debug-logger.js";
const tempRoots: string[] = [];
const handles: RuntimeHostHandle[] = [];

export async function startCompositionHost(
  host: RuntimeHost,
  options?: RuntimeHostStartOptions,
) {
  const handle = host.start(options);
  handles.push(handle);
  await handle.ready;
  return handle;
}

export async function disposeCompositionFixtures() {
  for (const handle of handles.splice(0).reverse()) await handle.stop();
  await processDebugLogger.drain();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
}

export async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const rootDir = join(tmpdir(), `llm-runtime-composition-${randomUUID()}`);
  tempRoots.push(rootDir);

  await mkdir(join(rootDir, "compiled"), { recursive: true });
  await mkdir(join(rootDir, "sessions"), { recursive: true });
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await mkdir(join(rootDir, "logs"), { recursive: true });
  await mkdir(join(rootDir, ".runtime"), { recursive: true });

  return {
    runtimeId: "test",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://model",
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
    requestRunner: {
      configPath: join(rootDir, "request-runner.config.json"),
    },
  };
}

export function createEmbeddingModelGatewayClient(
  modelFingerprint: string,
  calls: string[],
): ModelGatewayClient {
  return Object.freeze({
    async invoke() {
      throw new Error("unexpected model invocation");
    },
    async invokeRaw() {
      throw new Error("unexpected raw model invocation");
    },
    async embed(input) {
      calls.push(...input.texts);
      return Object.freeze({
        profileId: input.profileId,
        provider: "ollama" as const,
        model: "test-embedding-model",
        modelFingerprint,
        dimensions: 2,
        vectors: Object.freeze(
          input.texts.map(() => Object.freeze([1, 0] as const)),
        ),
      });
    },
  });
}
