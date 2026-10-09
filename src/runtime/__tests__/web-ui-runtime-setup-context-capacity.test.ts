import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupRoutes } from "../../web-ui/local-runtime/runtime-setup-routes.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { validateRuntimeSetupPlan } from "../../web-ui/local-runtime/runtime-setup-validation.js";
import { RuntimeConfigValidationError } from "../config/validation.js";

let rootDir = "";
let configPath: string | undefined;
let server: Server | undefined;
let origin = "";
let service: RuntimeSetupService;
const activate = vi.fn(async () => ({ status: "ready" as const }));

beforeEach(async () => {
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("LLM_RUNTIME_PROFILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  const artifacts = resolve(".codex/artifacts/onboarding-context-path-fixes");
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "context-capacity-"));
  configPath = undefined;
  activate.mockClear();
  service = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate,
  });
  const routes = new RuntimeSetupRoutes(service);
  server = createServer((request, response) => {
    void routes.handle({
      method: request.method ?? "GET",
      route: "runtime/setup",
      request,
      response,
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done, reject) =>
    server?.close((error) => (error ? reject(error) : done())),
  );
  server = undefined;
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

function save(
  contextWindowTokens?: number,
  extra: Record<string, unknown> = {},
) {
  return fetch(`${origin}/web-api/runtime/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      provider: "ollama",
      model: "configured-model",
      contextWindowTokens,
      deferActivation: true,
      ...extra,
    }),
  });
}

async function expectNoSavedSetup() {
  for (const file of [
    ".env",
    "local/runtime.config.json",
    "local/models/default.config.json",
  ]) {
    await expect(stat(join(rootDir, file))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  expect(activate).not.toHaveBeenCalled();
}

describe("setup context capacity at the HTTP boundary", () => {
  test.each([4_096, 6_319, 6_320])(
    "returns a safe field issue for %i without persisting setup",
    async (tokens) => {
      const response = await save(tokens);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = await response.json();
      expect(payload).toMatchObject({
        ok: false,
        error: "context_window_too_small",
        contextWindow: {
          field: "contextWindowTokens",
          declaredTokens: tokens,
          effectiveTokens: tokens,
          reservedTokens: 6_320,
          minimumTokens: 6_321,
        },
      });
      expect(payload.message).toEqual(expect.any(String));
      expect(JSON.stringify(payload)).not.toContain(rootDir);
      expect(JSON.stringify(payload)).not.toContain("runtime.config.json");
      await expectNoSavedSetup();
    },
  );

  test.each([6_321, 8_192, 16_384, 32_768, undefined])(
    "saves supported configuration capacity %s, preserving default on omission",
    async (tokens) => {
      const response = await save(tokens);
      expect(response.status).toBe(200);
      const profile = JSON.parse(
        await readFile(
          join(rootDir, "local/models/default.config.json"),
          "utf8",
        ),
      );
      expect(profile.contextWindowTokens).toBe(tokens ?? 32_768);
      expect(activate).not.toHaveBeenCalled();
    },
  );

  test("allows correction and retry after an insufficient-capacity rejection", async () => {
    expect((await save(4_096)).status).toBe(400);
    await expectNoSavedSetup();
    expect((await save(8_192)).status).toBe(200);
    const profile = JSON.parse(
      await readFile(join(rootDir, "local/models/default.config.json"), "utf8"),
    );
    expect(profile.contextWindowTokens).toBe(8_192);
  });

  test("preserves a saved draft and credentials when an edit has insufficient capacity", async () => {
    const initial = await save(16_384);
    const { setup } = await initial.json();
    const files = [
      ".env",
      "local/runtime.config.json",
      "local/models/default.config.json",
    ];
    const before = await Promise.all(
      files.map((file) => readFile(join(rootDir, file), "utf8")),
    );
    const response = await save(4_096, {
      connectionRevision: setup.editableConnection.revision,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("context_window_too_small");
    expect(
      await Promise.all(
        files.map((file) => readFile(join(rootDir, file), "utf8")),
      ),
    ).toEqual(before);
    expect(activate).not.toHaveBeenCalled();
  });

  test("uses preserved runner and format reserves for the selected environment instead of a fixed minimum", async () => {
    const local = join(rootDir, "local");
    await mkdir(local);
    configPath = join(local, "runtime.config.json");
    const runnerPath = join(local, "request-runner.config.json");
    const runner = {
      schemaVersion: 2,
      models: { defaults: { profileId: "default", steps: {} } },
      context: {
        outputReserveTokens: 2_048,
        safetyReserveTokens: 512,
        attachmentReserveTokens: 256,
      },
      stepDefaults: { timeoutMs: 90_000 },
      steps: {},
    };
    const existing = {
      requestRunner: { configRef: "./request-runner.config.json" },
      environment: { default: "review", profiles: { review: {} } },
      models: {
        defaults: {
          context: {
            formatTokenAccounting: {
              mode: "estimate",
              fixedOverheadTokens: 80,
            },
          },
        },
      },
    };
    await writeFile(runnerPath, JSON.stringify(runner));
    await writeFile(configPath, JSON.stringify(existing));
    await expect(
      service.save({
        provider: "ollama",
        model: "configured-model",
        contextWindowTokens: 2_896,
        deferActivation: true,
      }),
    ).rejects.toMatchObject({ code: "context_window_too_small" });
    const response = await save(2_896);
    expect(response.status).toBe(400);
    expect((await response.json()).contextWindow).toMatchObject({
      reservedTokens: 2_896,
      minimumTokens: 2_897,
      environmentId: "review",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(existing);
    expect(JSON.parse(await readFile(runnerPath, "utf8"))).toEqual(runner);
    expect((await save(4_096)).status).toBe(200);
    expect(JSON.parse(await readFile(runnerPath, "utf8"))).toEqual(runner);
  });

  test("maps the effective Ollama allocation from staged configuration without exposing paths", async () => {
    await expect(
      validateRuntimeSetupPlan({
        rootDir,
        config: { models: { providers: { ollama: { type: "ollama" } } } },
        modelConfig: {
          provider: "ollama",
          model: "configured-model",
          contextWindowTokens: 32_768,
          options: { num_ctx: 4_096 },
        },
        runnerPath: join(rootDir, "unused-runner.json"),
        runnerConfig: {
          schemaVersion: 2,
          models: { defaults: { profileId: "default", steps: {} } },
          context: {
            outputReserveTokens: 4_096,
            safetyReserveTokens: 1_200,
            attachmentReserveTokens: 1_024,
          },
          stepDefaults: { timeoutMs: 90_000 },
          steps: {},
        },
      }),
    ).rejects.toMatchObject({
      code: "context_window_too_small",
      contextWindow: {
        field: "contextWindowTokens",
        declaredTokens: 32_768,
        effectiveTokens: 4_096,
        allocationTokens: 4_096,
        minimumTokens: 6_321,
      },
    });
  });

  test("keeps unrelated validation failures and unknown errors redacted", async () => {
    for (const error of [
      new Error("private-token /private/config.json"),
      new RuntimeConfigValidationError("/private/config.json", [
        "private-token",
      ]),
    ]) {
      vi.spyOn(service, "save").mockRejectedValueOnce(error);
      const response = await save(8_192);
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error).toBe("runtime_setup_failed");
      expect(payload.contextWindow).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("private-token");
      expect(JSON.stringify(payload)).not.toContain("/private");
    }
  });
});
