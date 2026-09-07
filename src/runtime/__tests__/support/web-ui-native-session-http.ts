import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService } from "../../../sessions/session-service.js";
import { LocalRuntimeWebBackend } from "../../../web-ui/local-runtime-backend.js";
import { loadRuntimeConfig } from "../../config.js";
import { REQUEST_INVOKED_STEP_IDS } from "../../config/runner/contracts.js";
import { processDebugLogger } from "../../observability/debug-logger.js";

async function writeNativeSessionConfig(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, "runtime.config.json"),
    JSON.stringify({
      environment: {
        default: "prod",
        profiles: {
          prod: {
            paths: {
              runtimeDir: ".runtime/prod",
              agentWorkDir: ".runtime/prod/sandbox",
            },
          },
          dev: {
            paths: {
              runtimeDir: ".runtime/dev",
              agentWorkDir: ".runtime/dev/sandbox",
            },
          },
        },
      },
      logging: { enabled: false },
      models: {
        providers: {
          ollama: { type: "ollama", baseUrl: "http://127.0.0.1:1" },
        },
        defaults: { profileId: "native-read-test" },
        profiles: {
          "native-read-test": {
            provider: "ollama",
            model: "no-model-execution",
            contextWindowTokens: 32768,
          },
        },
      },
      requestRunner: { configRef: "./request-runner.config.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(rootDir, "request-runner.config.json"),
    JSON.stringify({
      models: {
        defaults: {
          profileId: "native-read-test",
          steps: Object.fromEntries(
            REQUEST_INVOKED_STEP_IDS.map((id) => [id, "native-read-test"]),
          ),
        },
      },
      context: {
        outputReserveTokens: 4096,
        safetyReserveTokens: 1200,
        attachmentReserveTokens: 1024,
      },
      steps: Object.fromEntries(
        REQUEST_INVOKED_STEP_IDS.map((id) => [id, { timeoutMs: 90000 }]),
      ),
    }),
    "utf8",
  );
}

export async function createNativeSessionHttpFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-native-read-state-"));
  await writeNativeSessionConfig(rootDir);
  let messageTimestamp = Date.now() - 86400000;
  const configurations = new Map<
    string,
    ReturnType<typeof loadRuntimeConfig>
  >();
  const services = new Map<string, SessionService>();
  const configFor = (environment: string) => {
    const existing = configurations.get(environment);
    if (existing) return existing;
    const config = loadRuntimeConfig({ rootDir, profileId: environment });
    configurations.set(environment, config);
    return config;
  };
  const createBackend = () =>
    new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
  let backend = createBackend();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    void backend.handleHttp(request, response, pathname);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    paths(environment = "prod") {
      return configFor(environment).paths;
    },
    sessions(environment = "prod"): SessionService {
      const existing = services.get(environment);
      if (existing) return existing;
      const service = new SessionService({
        sessionsDir: configFor(environment).paths.sessionsDir,
        now: () => new Date(messageTimestamp),
      });
      services.set(environment, service);
      return service;
    },
    timestamp(value: number): void {
      messageTimestamp = value;
    },
    request(
      method: "GET" | "POST" | "DELETE",
      suffix = "",
      body?: Record<string, unknown>,
      environment = "prod",
    ): Promise<Response> {
      const query = new URLSearchParams({ environment });
      return fetch(`${origin}/web-api/chat/sessions${suffix}?${query}`, {
        method,
        ...(body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
    },
    sessionBytes(sessionId: string, environment = "prod"): Promise<string> {
      return readFile(
        join(configFor(environment).paths.sessionsDir, `${sessionId}.json`),
        "utf8",
      );
    },
    async recreateBackend(): Promise<void> {
      await backend.stop();
      backend = createBackend();
    },
    async close(): Promise<void> {
      await backend.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await processDebugLogger.drain();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export type NativeSessionHttpFixture = Awaited<
  ReturnType<typeof createNativeSessionHttpFixture>
>;
