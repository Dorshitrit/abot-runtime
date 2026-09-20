import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../../model-gateway/index.js";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";

let rootDir = "";
let server: Server;
let backend: LocalRuntimeWebBackend;
let origin = "";
const activate = vi.fn(async () => ({ status: "ready" as const }));
const embed = vi.fn<NonNullable<ModelProviderAdapter["embed"]>>();

beforeEach(async () => {
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  const artifacts = resolve(
    ".codex/artifacts/onboarding-plugins-1.4-20260908/extended-onboarding",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "embedding-http-"));
  activate.mockClear();
  embed.mockReset();
  embed.mockImplementation(async ({ texts }) => ({
    kind: "embedded",
    modelFingerprint: "fixture:http",
    vectors: texts.map(() => [0.5, 0.5]),
  }));
  const providerAdapters = createModelProviderAdapterRegistry(
    ["ollama", "openai"].map((type) => ({
      type,
      supportsImageInput: false,
      embed,
      listEmbeddingModels: async () => ({
        kind: "listed" as const,
        models: ["fixture-embedding"],
      }),
      invoke: async () => ({ kind: "raw" as const, body: {} }),
    })),
  );
  backend = new LocalRuntimeWebBackend({
    rootDir,
    defaultEnvironmentId: "prod",
    providerAdapters,
    onRuntimeSetup: activate,
  });
  server = createServer((req, res) => {
    void backend.handleHttp(
      req,
      res,
      new URL(req.url!, "http://localhost").pathname,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await backend.stop();
  await new Promise<void>((done) => server.close(() => done()));
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

function post(
  route: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/web-api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
}
const get = async (route: string) =>
  (await fetch(`${origin}/web-api/${route}`)).json();
const saveConnection = () =>
  post("runtime/setup", {
    provider: "ollama",
    model: "fixture-chat",
    deferActivation: true,
  });

describe("extended onboarding HTTP boundary", () => {
  test("keeps fresh setup pending and resolves memory operations against the newly created local path", async () => {
    expect(await get("runtime/setup")).toMatchObject({
      setup: { configExists: false },
    });
    expect(await (await saveConnection()).json()).toMatchObject({
      activation: { status: "restart_required" },
    });
    expect(activate).not.toHaveBeenCalled();
    expect(await get("runtime/memory")).toMatchObject({
      ok: true,
      status: { enabled: false, providers: [{ id: "ollama", type: "ollama" }] },
    });
    expect(await get("runtime/memory/models?provider=ollama")).toMatchObject({
      ok: true,
      catalog: { supported: true, models: ["fixture-embedding"] },
    });
    const saved = await post("runtime/setup/embedding", {
      providerId: "ollama",
      model: "fixture-embedding",
    });
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(await saved.json()).toMatchObject({
      ok: true,
      status: { enabled: true },
      probe: { dimensions: 2 },
      restartRequired: true,
    });
    expect(await get("chat/models")).toMatchObject({
      profiles: [],
      availability: { status: "setup_required" },
    });
    expect(await get("runtime/setup")).toMatchObject({
      setup: { existingModel: { provider: "ollama", model: "fixture-chat" } },
    });
    expect(await get("runtime/memory")).toMatchObject({
      status: { enabled: true, model: "fixture-embedding" },
    });
    const config = JSON.parse(
      await readFile(join(rootDir, "local/runtime.config.json"), "utf8"),
    );
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["*"],
      deny: [],
    });
    expect((await get("runtime/plugins")).ok).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });

  test("returns a safe probe failure while preserving the added provider and credential for retry", async () => {
    await saveConnection();
    const key = "fixture-http-embedding-secret";
    embed.mockRejectedValueOnce(new Error(`provider echoed ${key}`));
    const response = await post("runtime/setup/embedding", {
      provider: "openai",
      model: "fixture-embedding",
      apiKey: key,
    });
    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(raw).not.toContain(key);
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      error: "embedding_setup_failed",
      providerSaved: true,
    });
    const status = JSON.stringify(await get("runtime/memory"));
    expect(status).not.toContain(key);
    expect(JSON.parse(status)).toMatchObject({
      status: {
        enabled: false,
        providers: expect.arrayContaining([{ id: "openai", type: "openai" }]),
      },
    });
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(key);
    expect(
      await (
        await post("runtime/setup/embedding", {
          providerId: "openai",
          model: "fixture-embedding",
        })
      ).json(),
    ).toMatchObject({ ok: true, status: { enabled: true } });
  });

  test("a failed probe returns its saved suffixed provider identity and retry does not create another provider", async () => {
    await saveConnection();
    const configPath = join(rootDir, "local/runtime.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.models.providers.openai = {
      type: "ollama",
      baseUrl: "http://127.0.0.1:19999",
    };
    config.models.providers["openai-2"] = {
      type: "ollama",
      baseUrl: "http://127.0.0.1:19998",
    };
    await writeFile(configPath, JSON.stringify(config));
    const key = "fixture-collision-http-key";
    embed.mockRejectedValueOnce(new Error(`upstream echoed ${key}`));

    const failed = await post("runtime/setup/embedding", {
      provider: "openai",
      model: "fixture-embedding",
      apiKey: key,
    });
    const payload = await failed.json();

    expect(failed.status).toBe(400);
    expect(payload).toMatchObject({
      providerSaved: true,
      savedProvider: { id: "openai-3", type: "openai" },
    });
    expect(Object.keys(payload.savedProvider).sort()).toEqual(["id", "type"]);
    expect(JSON.stringify(payload)).not.toContain(key);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.longTermMemory).toEqual(config.longTermMemory);
    const retry = await post("runtime/setup/embedding", {
      providerId: payload.savedProvider.id,
      model: "fixture-embedding",
    });
    expect(await retry.json()).toMatchObject({
      ok: true,
      status: { enabled: true, providerId: "openai-3" },
    });
    const after = JSON.parse(await readFile(configPath, "utf8"));
    expect(after.models.providers).toEqual(saved.models.providers);
    expect(
      after.models.embeddingProfiles[after.longTermMemory.embeddingProfileId]
        .provider,
    ).toBe("openai-3");
  });

  test("failed provider preparation does not report a saved provider receipt", async () => {
    await saveConnection();
    const response = await post("runtime/setup/embedding", {
      providerId: "missing-provider",
      model: "fixture-embedding",
    });
    const payload = await response.json();
    expect(response.status).toBe(404);
    expect(payload.providerSaved).toBe(false);
    expect(payload).not.toHaveProperty("savedProvider");
    expect(embed).not.toHaveBeenCalled();
  });

  test.each([
    "runtime/setup/embedding",
    "runtime/memory/enable",
    "runtime/memory/disable",
  ])("rejects cross-origin and form mutations at %s", async (route) => {
    await saveConnection();
    const before = await readFile(
      join(rootDir, "local/runtime.config.json"),
      "utf8",
    );
    const input = { providerId: "ollama", model: "fixture-embedding" };
    expect(
      (await post(route, input, { origin: "https://other.example" })).status,
    ).toBe(403);
    expect(
      (await post(route, input, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(
      await readFile(join(rootDir, "local/runtime.config.json"), "utf8"),
    ).toBe(before);
    expect(embed).not.toHaveBeenCalled();
  });

  test("bounds and sanitizes malformed secret-bearing embedding input before persistence", async () => {
    await saveConnection();
    const before = await readFile(join(rootDir, ".env"), "utf8");
    const malformed = await fetch(`${origin}/web-api/runtime/setup/embedding`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: '{"apiKey":"fixture-never-return",',
    });
    expect(await malformed.text()).not.toContain("fixture-never-return");
    const oversized = await post("runtime/setup/embedding", {
      apiKey: "x".repeat(17000),
    });
    expect(oversized.status).toBe(400);
    expect(await readFile(join(rootDir, ".env"), "utf8")).toBe(before);
    expect(embed).not.toHaveBeenCalled();
  });
});
