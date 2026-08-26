import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { handleRuntimeAdminBridgeMessage } from "../../bridge/runtime-admin.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

const TEST_PROVIDER_ID = "test-provider";
const TEST_PROFILE_ID = "test-profile";

const requiredRequestRunner = {
  models: {
    providers: {
      [TEST_PROVIDER_ID]: { type: "ollama" },
    },
    profiles: {
      [TEST_PROFILE_ID]: {
        provider: TEST_PROVIDER_ID,
        model: "test:model",
        contextWindowTokens: 32_768,
      },
    },
  },
  requestRunner: {
    configRef: "./request-runner.config.json",
  },
};

function createTestRunnerConfig() {
  return {
    models: {
      defaults: {
        profileId: TEST_PROFILE_ID,
        steps: Object.fromEntries(
          REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, TEST_PROFILE_ID]),
        ),
      },
    },
    context: {
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
    },
    steps: Object.fromEntries(
      REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, { timeoutMs: 90_000 }]),
    ),
  };
}

function createMockWebSocket() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    ws: {
      send(message: string) {
        sent.push(JSON.parse(message) as Record<string, unknown>);
      },
    },
  };
}

describe("runtime admin bridge handler", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempRoot(name: string): Promise<string> {
    const rootDir = `/tmp/${name}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    tempDirs.push(rootDir);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(createTestRunnerConfig()),
      "utf-8",
    );
    return rootDir;
  }

  test("ignores unrelated bridge messages", async () => {
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeAdminBridgeMessage(ws as never, {
      type: "run_request",
    });

    expect(handled).toBe(false);
    expect(sent).toEqual([]);
  });

  test("responds with config schema", async () => {
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeAdminBridgeMessage(ws as never, {
      type: "runtime.config.schema",
      correlationId: "admin-schema",
    });

    expect(handled).toBe(true);
    expect(sent[0]).toMatchObject({
      type: "runtime.config.schema.response",
      correlationId: "admin-schema",
      ok: true,
      schema: {
        title: "abot config",
      },
    });
  });

  test("reports runtime status and tails runtime logs", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-system");
    await mkdir(join(rootDir, "logs"), { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          paths: {
            traceFile: "logs/runtime.jsonl",
          },
          logging: {
            enabled: true,
            rotation: {
              maxFileSizeMb: 20,
              maxFiles: 10,
              maxAgeDays: 7,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(rootDir, "logs", "runtime.jsonl"),
      [
        JSON.stringify({ event: "first" }),
        JSON.stringify({ event: "second" }),
        JSON.stringify({ event: "third" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const { ws, sent } = createMockWebSocket();

    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.status.get",
          correlationId: "admin-status",
        },
        { rootDir, env: {} },
      ),
    ).toBe(true);
    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.logs.tail",
          correlationId: "admin-logs",
          lines: 2,
        },
        { rootDir, env: {} },
      ),
    ).toBe(true);

    expect(sent[0]).toMatchObject({
      type: "runtime.status.get.response",
      correlationId: "admin-status",
      ok: true,
      status: {
        pid: process.pid,
        config: {
          rootDir,
          configExists: true,
          traceFile: join(rootDir, "logs", "runtime.jsonl"),
        },
        restart: {
          supported: true,
          strategy: "systemctl-user",
        },
      },
    });
    expect(sent[1]).toMatchObject({
      type: "runtime.logs.tail.response",
      correlationId: "admin-logs",
      ok: true,
      log: {
        path: join(rootDir, "logs", "runtime.jsonl"),
        exists: true,
        lineCount: 2,
        lines: [
          JSON.stringify({ event: "second" }),
          JSON.stringify({ event: "third" }),
        ],
        entries: [{ event: "second" }, { event: "third" }],
      },
    });
  });

  test("accepts restart request after sending a structured response", async () => {
    const restartRequests: Array<{ reason?: string; delayMs: number }> = [];
    const { ws, sent } = createMockWebSocket();

    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.restart.request",
          correlationId: "admin-restart",
          reason: "config-updated",
          delayMs: 1,
        },
        {
          restartHandler: (request) => {
            restartRequests.push(request);
          },
        },
      ),
    ).toBe(true);

    expect(sent[0]).toMatchObject({
      type: "runtime.restart.request.response",
      correlationId: "admin-restart",
      ok: true,
      restart: {
        accepted: true,
        pid: process.pid,
        reason: "config-updated",
        delayMs: 1,
        strategy: "systemctl-user",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restartRequests).toEqual([
      {
        reason: "config-updated",
        delayMs: 1,
      },
    ]);
  });

  test.each([
    ["runtime_prod", "llm-runtime.service", "PROD runtime"],
    ["runtime_dev", "llm-runtime-dev.service", "DEV runtime"],
    ["model_gateway", "model-gateway.service", "Model gateway"],
  ])(
    "routes %s restart to its exact provider-agnostic service unit",
    async (serviceId, unit, label) => {
      const restartRequests: Array<{
        serviceId: string;
        unit: string;
        delayMs: number;
      }> = [];
      const { ws, sent } = createMockWebSocket();

      expect(
        await handleRuntimeAdminBridgeMessage(
          ws as never,
          {
            type: "runtime.service.restart.request",
            correlationId: `restart-${serviceId}`,
            serviceId,
            delayMs: 1,
          },
          {
            managedServiceRestartHandler: (request) => {
              restartRequests.push(request);
            },
          },
        ),
      ).toBe(true);

      expect(sent[0]).toMatchObject({
        type: "runtime.service.restart.request.response",
        correlationId: `restart-${serviceId}`,
        ok: true,
        restart: {
          accepted: true,
          serviceId,
          unit,
          label,
          delayMs: 1,
          strategy: "systemctl-user",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(restartRequests).toEqual([{ serviceId, unit, delayMs: 1 }]);
    },
  );

  test("rejects unknown managed service without scheduling a restart", async () => {
    const restartRequests: unknown[] = [];
    const { ws, sent } = createMockWebSocket();

    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.service.restart.request",
          correlationId: "restart-unknown",
          serviceId: "ollama",
          delayMs: 1,
        },
        {
          managedServiceRestartHandler: (request) => {
            restartRequests.push(request);
          },
        },
      ),
    ).toBe(true);

    expect(sent[0]).toEqual({
      type: "runtime.service.restart.request.response",
      correlationId: "restart-unknown",
      ok: false,
      error: "invalid_service_id",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restartRequests).toEqual([]);
  });

  test("runtime restart schedules the runtime-owned restart handler directly", async () => {
    const restartRequests: Array<{ reason?: string; delayMs: number }> = [];
    const order: string[] = [];
    const gatewayRequests: Array<{ url: string; body?: unknown }> = [];
    const { ws, sent } = createMockWebSocket();

    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.restart.request",
          correlationId: "admin-restart-with-gateway",
          reason: "config-updated",
          delayMs: 10,
        },
        {
          modelGatewayUrl: "http://127.0.0.1:3000/",
          modelGatewayRestartFetch: (async (url, init) => {
            const requestUrl = String(url);
            gatewayRequests.push({
              url: requestUrl,
              ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            });
            if (requestUrl.endsWith("/admin/restart")) {
              order.push("gateway.restart");
              return new Response(
                JSON.stringify({
                  accepted: true,
                  pid: 111,
                  delayMs: 1,
                  scheduledAt: new Date().toISOString(),
                  strategy: "systemctl-user",
                }),
                { status: 200 },
              );
            }
            if (requestUrl.endsWith("/admin/status")) {
              order.push("gateway.ready");
              return new Response(
                JSON.stringify({
                  pid: 222,
                  uptimeMs: 1,
                  startedAt: new Date().toISOString(),
                  now: new Date().toISOString(),
                }),
                { status: 200 },
              );
            }
            return new Response("not found", { status: 404 });
          }) as typeof fetch,
          restartHandler: (request) => {
            order.push("runtime.restart");
            restartRequests.push(request);
          },
        },
      ),
    ).toBe(true);

    expect(sent[0]).toMatchObject({
      type: "runtime.restart.request.response",
      correlationId: "admin-restart-with-gateway",
      ok: true,
      restart: {
        accepted: true,
        reason: "config-updated",
        delayMs: 10,
        strategy: "systemctl-user",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(gatewayRequests).toEqual([]);
    expect(order).toEqual(["runtime.restart"]);
    expect(restartRequests).toEqual([
      {
        reason: "config-updated",
        delayMs: 10,
      },
    ]);
  });

  test("gets, validates, and patches config through bridge frames", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-bridge");
    const configPath = join(rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          ...requiredRequestRunner,
          logging: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { ws, sent } = createMockWebSocket();

    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.config.get",
          correlationId: "admin-get",
        },
        { rootDir, env: {} },
      ),
    ).toBe(true);
    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.config.validate",
          correlationId: "admin-validate",
          patch: {
            logging: {
              enabled: false,
            },
          },
        },
        { rootDir },
      ),
    ).toBe(true);
    expect(
      await handleRuntimeAdminBridgeMessage(
        ws as never,
        {
          type: "runtime.config.patch",
          correlationId: "admin-patch",
          patch: {
            logging: {
              enabled: false,
            },
          },
        },
        { rootDir },
      ),
    ).toBe(true);

    expect(sent[0]).toMatchObject({
      type: "runtime.config.get.response",
      correlationId: "admin-get",
      ok: true,
      metadata: {
        rootDir,
        configPath,
        exists: true,
      },
      fileConfig: {
        ...requiredRequestRunner,
        logging: {
          enabled: true,
        },
      },
    });
    expect(sent[1]).toMatchObject({
      type: "runtime.config.validate.response",
      correlationId: "admin-validate",
      ok: true,
      config: {
        ...requiredRequestRunner,
        logging: {
          enabled: false,
        },
      },
    });
    expect(sent[2]).toMatchObject({
      type: "runtime.config.patch.response",
      correlationId: "admin-patch",
      ok: true,
      restartRequired: true,
      config: {
        ...requiredRequestRunner,
        logging: {
          enabled: false,
        },
      },
    });
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({
      ...requiredRequestRunner,
      logging: {
        enabled: false,
      },
    });
  });

  test("returns validation failure through bridge frames", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-bridge-invalid");
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeAdminBridgeMessage(
      ws as never,
      {
        type: "runtime.config.validate",
        correlationId: "admin-invalid",
        config: {
          ...requiredRequestRunner,
          plugins: {
            enabled: "no",
          },
        },
      },
      { rootDir },
    );

    expect(handled).toBe(true);
    expect(sent).toEqual([
      {
        type: "runtime.config.validate.response",
        correlationId: "admin-invalid",
        ok: false,
        issues: ["plugins.enabled must be a boolean"],
        message: [
          `Invalid runtime config at ${join(rootDir, "runtime.config.json")}:`,
          "- plugins.enabled must be a boolean",
        ].join("\n"),
      },
    ]);
  });
});
