import { parse } from "dotenv";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";

type SetupBackend = {
  backend: LocalRuntimeWebBackend;
  server: Server;
  origin: string;
};

const artifactRoot = resolve(".codex/artifacts/onboarding-context-path-fixes");
const running: SetupBackend[] = [];
let rootDir = "";

beforeEach(async () => {
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "web setup ספריה-"));
});

async function closeBackend(handle: SetupBackend): Promise<void> {
  await handle.backend.stop();
  await new Promise<void>((done, reject) =>
    handle.server.close((error) => error ? reject(error) : done()),
  );
  running.splice(running.indexOf(handle), 1);
}

afterEach(async () => {
  for (const handle of [...running]) await closeBackend(handle);
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

async function startBackend(configPath?: string): Promise<SetupBackend> {
  const backend = new LocalRuntimeWebBackend({
    rootDir,
    defaultEnvironmentId: "prod",
    configPath,
  });
  const server = createServer((req, res) => {
    void backend.handleHttp(
      req,
      res,
      new URL(req.url!, "http://localhost").pathname,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const handle = {
    backend,
    server,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
  running.push(handle);
  return handle;
}

test("fresh Web setup keeps status and config on its saved absolute path after restart", async () => {
  const initial = await startBackend();
  const saved = await fetch(`${initial.origin}/web-api/runtime/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: initial.origin },
    body: JSON.stringify({
      provider: "ollama",
      model: "config-path-fixture",
      deferActivation: true,
    }),
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    setup: { configExists: true },
  });
  await closeBackend(initial);

  const environment = parse(await readFile(join(rootDir, ".env"), "utf8"));
  const configPath = environment.LLM_RUNTIME_CONFIG_FILE;
  expect(isAbsolute(configPath)).toBe(true);
  expect(configPath).toBe(join(rootDir, "local/runtime.config.json"));
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", configPath);
  // Ordinary server startup forwards the .env selection into backend options.
  const restarted = await startBackend(process.env.LLM_RUNTIME_CONFIG_FILE);

  const setup = await fetch(`${restarted.origin}/web-api/runtime/setup`);
  expect(setup.status).toBe(200);
  expect(await setup.json()).toMatchObject({
    setup: { configExists: true },
  });

  const status = await fetch(`${restarted.origin}/web-api/runtime/status`);
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    status: { config: { rootDir, configPath, configExists: true } },
  });

  const config = await fetch(`${restarted.origin}/web-api/runtime/config`);
  expect(config.status).toBe(200);
  expect(await config.json()).toMatchObject({
    metadata: { rootDir, configPath, exists: true },
    effectiveConfig: {
      models: { profiles: { default: { model: "config-path-fixture" } } },
    },
  });
});
