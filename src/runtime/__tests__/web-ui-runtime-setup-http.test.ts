import { LocalRuntimeApiRouter } from "../../web-ui/local-runtime/api-router.js";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";

let rootDir = "";
let server: Server;
let backend: LocalRuntimeWebBackend;
let origin = "";
beforeEach(async () => {
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  const artifactRoot = resolve(
    ".codex/artifacts/onboarding-plugins-1.4-20260908",
  );
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "setup-http-"));
  backend = new LocalRuntimeWebBackend({
    rootDir,
    defaultEnvironmentId: "prod",
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

function save(headers: Record<string, string>, body: string) {
  return fetch(`${origin}/web-api/runtime/setup`, {
    method: "POST",
    headers,
    body,
  });
}

describe("runtime setup HTTP boundary", () => {
  test("keeps saved setup gated until gateway activation without returning credentials", async () => {
    const initial = await fetch(`${origin}/web-api/runtime/setup`);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toMatchObject({
      ok: true,
      setup: { status: "required" },
    });
    const response = await save(
      { "content-type": "application/json", origin },
      JSON.stringify({
        provider: "openai",
        model: "test-model",
        apiKey: "fixture-http-fake-key",
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.text();
    expect(result).not.toContain("fixture-http-fake-key");
    expect(JSON.parse(result)).toMatchObject({
      activation: { status: "restart_required" },
    });
    const catalog = await fetch(`${origin}/web-api/chat/models`);
    expect(await catalog.json()).toMatchObject({
      availability: { status: "setup_required" },
      profiles: [],
    });
  });

  test("rejects cross-origin and form writes before persistence", async () => {
    const body = JSON.stringify({ provider: "ollama", model: "test-model" });
    const crossSite = await save(
      { "content-type": "application/json", origin: "https://other.example" },
      body,
    );
    expect(crossSite.status).toBe(403);
    const form = await save({ "content-type": "text/plain", origin }, body);
    expect(form.status).toBe(415);
    await expect(
      stat(join(rootDir, "local/runtime.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("defers apply while the Web owns an acknowledged request before owner dispatch", async () => {
    const apply = vi.fn(async () => ({ status: "ready" }));
    const requests = {
      healthDetails: vi.fn(() => [{ requestId: "accepted-before-rpc" }]),
    };
    const router = new LocalRuntimeApiRouter(
      { rootDir, defaultEnvironmentId: "prod", providerAdapters: {} as never },
      { applyConfiguration: apply } as never,
      requests as never,
    );
    const request = {
      url: "/web-api/runtime/config/apply",
      method: "POST",
      headers: { "content-type": "application/json" },
      socket: {},
    };
    let raw = "";
    const response = {
      writeHead: vi.fn(),
      end: (body: string) => {
        raw = body;
      },
    };
    await router.handle(request as never, response as never);
    expect(JSON.parse(raw)).toMatchObject({
      activation: { status: "restart_required" },
    });
    expect(apply).not.toHaveBeenCalled();
    requests.healthDetails.mockReturnValue([]);
    await router.handle(request as never, response as never);
    expect(JSON.parse(raw)).toMatchObject({ activation: { status: "ready" } });
    expect(apply).toHaveBeenCalledOnce();
  });

  test("returns bounded safe errors for malformed and oversized secret-bearing input", async () => {
    const malformed = await save(
      { "content-type": "application/json", origin },
      '{"apiKey":"never-return-this",',
    );
    expect(await malformed.text()).not.toContain("never-return-this");
    const oversized = await save(
      { "content-type": "application/json", origin },
      JSON.stringify({ apiKey: "x".repeat(17000) }),
    );
    expect(oversized.status).toBe(400);
    await expect(stat(join(rootDir, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
