import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let server: Server;
let backend: LocalRuntimeWebBackend;
let origin = "";
const activate = vi.fn(async () => ({
  status: "restart_required" as const,
  message: "Fixture activation deferred.",
}));

beforeEach(async () => {
  fixture = await createModelSetupFixture();
  activate.mockClear();
  backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
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
  await fixture.cleanup();
});

function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/web-api/runtime/config/models`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
}
const get = async (path: string) =>
  (await fetch(`${origin}/web-api/${path}`)).json();

describe("post-onboarding model addition HTTP", () => {
  test("adds models incrementally and exposes the new profile ID for Configuration selection without activating", async () => {
    const metadata = await fetch(
      `${origin}/web-api/runtime/config/models/setup`,
    );
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.json()).toMatchObject({
      ok: true,
      providers: [{ id: "ollama", type: "ollama", requiresApiKey: false }],
      profileIds: ["default"],
    });
    const local = await post({
      profileId: "local-two",
      providerId: "ollama",
      model: "fixture-local-two",
    });
    expect(await local.json()).toEqual({
      ok: true,
      model: {
        profileId: "local-two",
        providerId: "ollama",
        provider: "ollama",
        model: "fixture-local-two",
      },
      restartRequired: true,
    });
    const secret = "fixture-http-isolated-key";
    const cloud = await post({
      profileId: "cloud-one",
      model: "fixture-cloud",
      newProvider: { id: "work-cloud", type: "openai" },
      apiKey: secret,
    });
    expect(cloud.status).toBe(200);
    expect(cloud.headers.get("cache-control")).toBe("no-store");
    expect(await cloud.text()).not.toContain(secret);
    expect(await get("runtime/config/models/setup")).toMatchObject({
      providers: expect.arrayContaining([
        {
          id: "work-cloud",
          type: "openai",
          label: "work-cloud",
          requiresApiKey: true,
          credentialConfigured: true,
        },
      ]),
      profileIds: ["default", "local-two", "cloud-one"],
    });
    const workspace = await get("runtime/config/dashboard");
    expect(
      workspace.dashboard.files.models.find(
        (model: { id: string }) => model.id === "cloud-one",
      ),
    ).toMatchObject({
      id: "cloud-one",
      source: { type: "inlineModelProfile", profileId: "cloud-one" },
      config: { model: "fixture-cloud", provider: "work-cloud" },
    });
    expect(JSON.stringify(workspace)).not.toContain(secret);
    expect((await get("chat/models")).defaultProfileId).toBe("default");
    expect(activate).not.toHaveBeenCalled();
  });

  test("keeps a saved model after deferred Apply and does not attempt another addition", async () => {
    const added = await post({
      profileId: "pending",
      model: "fixture",
      providerId: "ollama",
    });
    expect(added.status).toBe(200);
    const apply = await fetch(`${origin}/web-api/runtime/config/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
    expect(await apply.json()).toMatchObject({
      activation: { status: "restart_required" },
    });
    expect(activate).toHaveBeenCalledOnce();
    expect((await fixture.readConfig()).models.profiles.pending).toMatchObject({
      model: "fixture",
    });
    expect((await fixture.service.catalog()).profileIds).toEqual([
      "default",
      "pending",
    ]);
  });

  test("reports sanitized credential-only persistence and accepts a retry without the key", async () => {
    const key = "fixture-http-partial-private";
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockRejectedValueOnce(
      new Error(`provider echoed ${key}`),
    );
    const input = {
      profileId: "retry",
      model: "fixture",
      newProvider: { id: "retry-provider", type: "openai" },
    };
    const response = await post({ ...input, apiKey: key });
    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(raw).not.toContain(key);
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      error: "model_save_failed",
      credentialSaved: true,
    });
    expect(await fixture.readEnv()).toContain(key);
    expect((await post(input)).status).toBe(200);
    expect((await get("runtime/config/models/setup")).profileIds).toEqual([
      "default",
      "retry",
    ]);
  });

  test("rejects cross-origin, form, and duplicate profile writes without changing saved settings", async () => {
    const config = await readFile(fixture.configPath, "utf8");
    const input = {
      profileId: "new-model",
      model: "fixture",
      providerId: "ollama",
    };
    expect(
      (await post(input, { origin: "https://other.example" })).status,
    ).toBe(403);
    expect((await post(input, { "content-type": "text/plain" })).status).toBe(
      415,
    );
    const collision = await post({ ...input, profileId: "default" });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({
      error: "model_profile_exists",
      credentialSaved: false,
    });
    expect(await readFile(fixture.configPath, "utf8")).toBe(config);
  });

  test("bounds malformed secret-bearing bodies and rejects unsupported methods", async () => {
    const env = await fixture.readEnv();
    const malformed = await fetch(`${origin}/web-api/runtime/config/models`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: '{"apiKey":"fixture-never-return",',
    });
    expect(await malformed.text()).not.toContain("fixture-never-return");
    const oversized = await post({ apiKey: "x".repeat(17000) });
    expect(oversized.status).toBe(400);
    expect(await fixture.readEnv()).toBe(env);
    expect(
      (await fetch(`${origin}/web-api/runtime/config/models`)).status,
    ).toBe(405);
  });
});
