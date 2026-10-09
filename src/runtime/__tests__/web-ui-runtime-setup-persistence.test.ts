import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startWebUiServer } from "../../web-ui/server.js";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import * as setupFiles from "../../../scripts/runtime-setup-files.js";
import * as setupDirectories from "../../../scripts/runtime-setup-directories.js";
import * as setupCredentials from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import * as setupDraft from "../../web-ui/local-runtime/runtime-setup-draft.js";

const captured = vi.hoisted(() => ({ server: undefined as Server | undefined }));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      captured.server = actual.createServer(...args);
      return captured.server;
    },
  };
});

const artifactRoot = resolve(".codex/artifacts/runtime-setup-persistence-tests");
let rootDir = "";
let origin = "";
let handle: ReturnType<typeof startWebUiServer> | undefined;

beforeEach(async () => {
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "setup-"));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

async function start() {
  const startup = vi.spyOn(LocalRuntimeWebBackend.prototype, "start");
  handle = startWebUiServer({
    rootDir, host: "127.0.0.1", port: 0, backend: "runtime", environments: [],
  });
  if (!captured.server!.listening) await once(captured.server!, "listening");
  await startup.mock.results.at(-1)!.value;
  startup.mockRestore();
  const port = (captured.server!.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
}

function requestSetup(overrides: Record<string, unknown> = {}) {
  return fetch(`${origin}/web-api/runtime/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      provider: "ollama", model: "setup-persistence-fixture", deferActivation: true,
      ...overrides,
    }),
  });
}

async function readSetup() {
  const response = await fetch(`${origin}/web-api/runtime/setup`);
  expect(response.status).toBe(200);
  return (await response.json()).setup;
}

test.each(["template", "receipt"] as const)(
  "keeps fresh setup unconfigured when initial %s persistence fails",
  async (failure) => {
    await start();
    const error = new Error(`fixture-${failure}-failure`);
    if (failure === "template") {
      vi.spyOn(setupFiles, "readJsonObject").mockRejectedValueOnce(error);
    } else {
      vi.spyOn(setupDraft, "createRuntimeSetupDraft").mockRejectedValueOnce(error);
    }
    const response = await requestSetup();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "runtime_setup_failed" });
    await expect(readFile(join(rootDir, ".env"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(rootDir, "local/runtime.config.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readSetup()).toMatchObject({ status: "required", configExists: false });
  },
);

test("keeps a failed credential draft resumable and saves its configuration path on retry", async () => {
  await start();
  vi.spyOn(setupCredentials, "persistRuntimeSetupCredentials")
    .mockRejectedValueOnce(new Error("fixture-credential-write-failed"));
  const connection = {
    provider: "openai", model: "setup-pending-fixture", apiKey: "fixture-not-a-real-key",
  };
  const failed = await requestSetup(connection);
  expect(failed.status).toBe(400);
  expect(await failed.json()).toMatchObject({ error: "runtime_setup_failed" });
  await expect(readFile(join(rootDir, ".env"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
  const configPath = join(rootDir, "local/runtime.config.json");
  expect(JSON.parse(await readFile(configPath, "utf8")).models.profiles.default)
    .toBeDefined();
  const setup = await readSetup();
  expect(setup).toMatchObject({
    status: "required", configExists: true,
    editableConnection: { revision: expect.any(String) },
  });
  const resumed = await requestSetup({
    ...connection, connectionRevision: setup.editableConnection.revision,
  });
  expect(resumed.status).toBe(200);
  expect(parse(await readFile(join(rootDir, ".env"), "utf8")))
    .toMatchObject({
      LLM_RUNTIME_CONFIG_FILE: configPath, OPENAI_API_KEY: connection.apiKey,
    });
  expect(await readSetup()).toMatchObject({ status: "ready", configExists: true });
});

test("keeps the saved configuration usable when directory initialization fails after persistence", async () => {
  await start();
  vi.spyOn(setupDirectories, "initializeConfiguredRuntimeDirectories")
    .mockRejectedValueOnce(new Error("fixture-directory-initialization-failed"));
  const response = await requestSetup();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "runtime_setup_failed" });
  const configPath = parse(await readFile(join(rootDir, ".env"), "utf8"))
    .LLM_RUNTIME_CONFIG_FILE;
  expect(configPath).toBe(join(rootDir, "local/runtime.config.json"));
  expect(JSON.parse(await readFile(configPath, "utf8")).models.profiles.default)
    .toBeDefined();
  expect(await readSetup()).toMatchObject({
    status: "ready", configExists: true,
    editableConnection: { revision: expect.any(String) },
  });
});
