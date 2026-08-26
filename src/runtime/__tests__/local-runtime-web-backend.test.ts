import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { handleRunRequest as handleRunRequestType } from "../request/handler.js";
import type { RequestSteeringInbox } from "../request/request-steering.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

vi.mock("../request/handler.js", () => ({
  handleRunRequest: vi.fn(async (ws, msg) => {
    ws.send(
      JSON.stringify({
        type: "completed",
        requestId: msg.requestId,
        output: "ok",
      }),
    );
  }),
}));

const { handleRunRequest } = await import("../request/handler.js");
const { LocalRuntimeWebBackend } =
  await import("../../web-ui/local-runtime-backend.js");
const { REQUEST_INVOKED_STEP_IDS } =
  await import("../config/runner/contracts.js");

const mockedHandleRunRequest = vi.mocked(
  handleRunRequest as typeof handleRunRequestType,
);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForWsOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForWsJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", reject);
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function writeRequestRunnerConfig(
  rootDir: string,
  profileId: string,
): Promise<void> {
  await writeFile(
    join(rootDir, "request-runner.config.json"),
    JSON.stringify({
      models: {
        defaults: {
          profileId,
          steps: Object.fromEntries(
            REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, profileId]),
          ),
        },
      },
      context: {
        outputReserveTokens: 4_096,
        safetyReserveTokens: 1_200,
        attachmentReserveTokens: 1_024,
      },
      steps: Object.fromEntries(
        REQUEST_INVOKED_STEP_IDS.map((stepId) => [
          stepId,
          { timeoutMs: 90_000 },
        ]),
      ),
    }),
  );
}

describe("local runtime web backend", () => {
  let rootDir = "";
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;

  beforeEach(async () => {
    configureDebugLogger({ enabled: false });
    mockedHandleRunRequest.mockClear();
    rootDir = await mkdtemp(join(tmpdir(), "llm-runtime-web-backend-"));
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
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
          logging: {
            enabled: false,
          },
          models: {
            providers: {
              ollama: {
                type: "ollama",
                baseUrl: "http://127.0.0.1:11434",
              },
            },
            defaults: {
              profileId: "local-test",
            },
            profiles: {
              "local-test": {
                label: "Local Test",
                provider: "ollama",
                model: "test-model",
                contextWindowTokens: 32_768,
              },
            },
          },
          requestRunner: {
            configRef: "./request-runner.config.json",
          },
        },
        null,
        2,
      ),
    );
    await writeRequestRunnerConfig(rootDir, "local-test");
  });

  afterEach(async () => {
    wss?.close();
    wss = undefined;
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = "";
    }
    resetDebugLoggerConfig();
  });

  test("serves models from the selected runtime profile", async () => {
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=dev`,
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.ok).toBe(true);
    expect(payload.defaultProfileId).toBe("local-test");
    expect(payload.availability).toEqual({ status: "ready" });
    expect(payload.profiles).toEqual([
      expect.objectContaining({
        id: "local-test",
        label: "Local Test",
        providerId: "ollama",
        provider: "ollama",
        model: "test-model",
      }),
    ]);
  });

  test("keeps onboarding routes healthy before a provider and model are configured", async () => {
    await rm(join(rootDir, "runtime.config.json"));
    await rm(join(rootDir, "request-runner.config.json"));
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);

    const modelsResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
    );
    const modelsPayload = (await modelsResponse.json()) as Record<
      string,
      unknown
    >;
    const sessionsResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/sessions?environment=prod`,
    );
    const sessionsPayload = (await sessionsResponse.json()) as Record<
      string,
      unknown
    >;
    const dashboardResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/runtime/config/dashboard?environment=prod`,
    );
    const dashboardPayload = (await dashboardResponse.json()) as {
      dashboard?: { files?: { runtime?: { exists?: boolean } } };
    };
    const chatResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          sessionId: "session-1",
          environment: "prod",
        }),
      },
    );
    const chatPayload = (await chatResponse.json()) as Record<string, unknown>;
    const attachmentResponses = await Promise.all(
      ["POST", "GET", "DELETE"].map((method) =>
        fetch(
          `http://127.0.0.1:${port}/web-api/chat/attachments?environment=prod&sessionId=session-1`,
          { method },
        ),
      ),
    );
    const attachmentPayloads = await Promise.all(
      attachmentResponses.map(
        async (response) => (await response.json()) as Record<string, unknown>,
      ),
    );

    expect(modelsResponse.status).toBe(200);
    expect(modelsPayload).toEqual({
      ok: true,
      defaultProfileId: "",
      profiles: [],
      availability: {
        status: "setup_required",
        code: "runtime_configuration_required",
        message: expect.stringContaining("provider and model"),
      },
      modes: [],
    });
    expect(sessionsResponse.status).toBe(200);
    expect(sessionsPayload).toMatchObject({
      ok: true,
      sessions: [],
      availability: { status: "setup_required" },
    });
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardPayload.dashboard?.files?.runtime?.exists).toBe(false);
    expect(chatResponse.status).toBe(409);
    expect(chatPayload).toMatchObject({
      ok: false,
      error: "runtime_setup_required",
      message: expect.stringContaining("provider and model"),
      availability: { status: "setup_required" },
    });
    expect(attachmentResponses.map((response) => response.status)).toEqual([
      409, 409, 409,
    ]);
    expect(attachmentPayloads).toEqual(
      attachmentPayloads.map(() =>
        expect.objectContaining({
          ok: false,
          error: "runtime_setup_required",
          availability: expect.objectContaining({
            status: "setup_required",
          }),
        }),
      ),
    );
    expect(mockedHandleRunRequest).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a provider without a model profile",
      {
        models: { providers: { ollama: { type: "ollama" } } },
        requestRunner: { configRef: "./request-runner.config.json" },
      },
      "model profile",
    ],
    [
      "a model without a provider",
      {
        models: {
          profiles: {
            "local-test": {
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: { configRef: "./request-runner.config.json" },
      },
      "provider",
    ],
    [
      "a model that references an unknown provider",
      {
        models: {
          providers: { ollama: { type: "ollama" } },
          profiles: {
            "local-test": {
              provider: "missing",
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: { configRef: "./request-runner.config.json" },
      },
      "declared provider",
    ],
    [
      "a profile without a concrete model ID",
      {
        models: {
          providers: { ollama: { type: "ollama" } },
          profiles: {
            "local-test": {
              provider: "ollama",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: { configRef: "./request-runner.config.json" },
      },
      "concrete model ID",
    ],
    [
      "a usable model without request-runner setup",
      {
        models: {
          providers: { ollama: { type: "ollama" } },
          profiles: {
            "local-test": {
              provider: "ollama",
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
        },
      },
      "request-runner",
    ],
    [
      "a usable model with an empty request-runner section",
      {
        models: {
          providers: { ollama: { type: "ollama" } },
          profiles: {
            "local-test": {
              provider: "ollama",
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: {},
      },
      "request-runner",
    ],
    [
      "a usable model with an empty request-runner reference",
      {
        models: {
          providers: { ollama: { type: "ollama" } },
          profiles: {
            "local-test": {
              provider: "ollama",
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: { configRef: "" },
      },
      "request-runner",
    ],
  ])(
    "reports setup required for %s",
    async (_case, runtimeConfig, expectedReason) => {
      await writeFile(
        join(rootDir, "runtime.config.json"),
        JSON.stringify(runtimeConfig),
      );
      const backend = new LocalRuntimeWebBackend({
        rootDir,
        defaultEnvironmentId: "prod",
      });
      server = createServer((req, res) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        void backend.handleHttp(req, res, pathname);
      });
      const port = await listen(server);

      const response = await fetch(
        `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
      );
      const payload = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        ok: true,
        defaultProfileId: "",
        profiles: [],
        availability: {
          status: "setup_required",
          code: "runtime_configuration_required",
          message: expect.stringContaining(expectedReason),
        },
      });
    },
  );

  test("surfaces malformed and invalid existing runtime configs as errors", async () => {
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);

    await writeFile(join(rootDir, "runtime.config.json"), "{ malformed");
    const malformedResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
    );
    const malformedPayload = (await malformedResponse.json()) as Record<
      string,
      unknown
    >;

    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: [],
        requestRunner: { configRef: "./request-runner.config.json" },
      }),
    );
    const invalidResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
    );
    const invalidPayload = (await invalidResponse.json()) as Record<
      string,
      unknown
    >;

    expect(malformedResponse.status).toBe(500);
    expect(malformedPayload).toMatchObject({
      ok: false,
      error: "local_runtime_backend_error",
    });
    expect(invalidResponse.status).toBe(500);
    expect(invalidPayload).toMatchObject({
      ok: false,
      error: "local_runtime_backend_error",
      message: expect.stringContaining("models must be an object"),
    });
    expect(malformedPayload).not.toHaveProperty("availability");
    expect(invalidPayload).not.toHaveProperty("availability");
  });

  test("onboards an empty config object but rejects empty config bytes", async () => {
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);

    await writeFile(join(rootDir, "runtime.config.json"), "{}\n");
    const emptyObjectResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
    );
    const emptyObjectPayload = (await emptyObjectResponse.json()) as Record<
      string,
      unknown
    >;

    await writeFile(join(rootDir, "runtime.config.json"), "  \n\t");
    const emptyBytesResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
    );
    const emptyBytesPayload = (await emptyBytesResponse.json()) as Record<
      string,
      unknown
    >;

    expect(emptyObjectResponse.status).toBe(200);
    expect(emptyObjectPayload).toMatchObject({
      ok: true,
      profiles: [],
      availability: { status: "setup_required" },
    });
    expect(emptyBytesResponse.status).toBe(500);
    expect(emptyBytesPayload).toMatchObject({
      ok: false,
      error: "local_runtime_backend_error",
    });
    expect(emptyBytesPayload).not.toHaveProperty("availability");
  });

  test("reports image support using the effective chat model policy", async () => {
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          environment: {
            default: "prod",
            profiles: {
              prod: {
                paths: {
                  runtimeDir: ".runtime/prod",
                  agentWorkDir: ".runtime/prod/sandbox",
                },
              },
            },
          },
          logging: {
            enabled: false,
          },
          models: {
            providers: {
              ollama: {
                type: "ollama",
                baseUrl: "http://127.0.0.1:11434",
              },
            },
            defaults: {
              overrideClientPreference: true,
              profileId: "text-chat",
            },
            profiles: {
              "text-chat": {
                provider: "ollama",
                model: "text-model",
                contextWindowTokens: 32_768,
                capabilities: {
                  inputModalities: ["text"],
                },
              },
              "vision-client": {
                provider: "ollama",
                model: "vision-model",
                contextWindowTokens: 32_768,
                capabilities: {
                  inputModalities: ["text", "image"],
                },
              },
            },
          },
          requestRunner: {
            configRef: "./request-runner.config.json",
          },
        },
        null,
        2,
      ),
    );
    await writeRequestRunnerConfig(rootDir, "text-chat");
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/models?environment=prod`,
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const profiles = payload.profiles as Record<string, unknown>[];

    expect(response.ok).toBe(true);
    expect(
      profiles.find((profile) => profile.id === "vision-client"),
    ).toMatchObject({
      provider: "ollama",
      supportsImageInput: false,
    });
  });

  test("runs chat requests in-process and emits realtime events", async () => {
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (client) => backend.handleRealtimeConnection(client));
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    server.on("upgrade", (req, socket, head) => {
      wss?.handleUpgrade(req, socket, head, (client) => {
        wss?.emit("connection", client, req);
      });
    });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/web-realtime`);
    await waitForWsOpen(ws);
    const nextMessage = waitForWsJson(ws);

    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          sessionId: "session-1",
          environment: "dev",
          agentMode: "reasoning",
          toolPermissionMode: "ask",
        }),
      },
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const realtime = await nextMessage;
    ws.close();

    expect(response.ok).toBe(true);
    expect(payload.requestId).toEqual(expect.stringMatching(/^web-/));
    expect(mockedHandleRunRequest).toHaveBeenCalledTimes(1);
    expect(mockedHandleRunRequest.mock.calls[0][1]).toMatchObject({
      type: "run_request",
      sessionId: "session-1",
      text: "hello",
      toolPermissionMode: "ask",
    });
    expect(
      mockedHandleRunRequest.mock.calls[0][2]?.toolApprovalController,
    ).toBeDefined();
    expect(
      mockedHandleRunRequest.mock.calls[0][2]?.runtimeConfig?.runtimeId,
    ).toBe("dev");
    expect(realtime).toMatchObject({
      type: "completed",
      requestId: payload.requestId,
      sessionId: "session-1",
      environment: "dev",
      output: "ok",
    });
  });

  test("steers the exact active request through its existing inbox", async () => {
    const release = deferred();
    let steeringInbox: RequestSteeringInbox | undefined;
    mockedHandleRunRequest.mockImplementationOnce(
      async (_ws, _msg, options) => {
        steeringInbox = options?.requestSteering;
        await release.promise;
      },
    );
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (client) => backend.handleRealtimeConnection(client));
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    server.on("upgrade", (req, socket, head) => {
      wss?.handleUpgrade(req, socket, head, (client) => {
        wss?.emit("connection", client, req);
      });
    });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/web-realtime`);
    await waitForWsOpen(ws);

    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Start the work",
          sessionId: "session-steering",
          environment: "dev",
        }),
      },
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const requestId = String(payload.requestId);
    await vi.waitFor(() => expect(steeringInbox).toBeDefined());

    const acknowledgement = waitForWsJson(ws);
    ws.send(
      JSON.stringify({
        type: "steer_request",
        requestId,
        steerId: "steer-1",
        text: "Use the shorter format instead",
      }),
    );

    await expect(acknowledgement).resolves.toEqual({
      type: "steer_ack",
      requestId,
      steerId: "steer-1",
      accepted: true,
      acceptedSequence: 1,
    });
    expect(mockedHandleRunRequest).toHaveBeenCalledTimes(1);
    expect(steeringInbox?.snapshot().updates).toEqual([
      {
        steerId: "steer-1",
        sequence: 1,
        text: "Use the shorter format instead",
      },
    ]);

    release.resolve();
    ws.close();
  });

  test("serves exact owned image attachment bytes with private preview headers", async () => {
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const uploadResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/attachments?environment=dev&sessionId=session-image&name=screen.png`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: bytes,
      },
    );
    const uploadPayload = (await uploadResponse.json()) as {
      attachment: Record<string, unknown>;
    };
    const attachment = uploadPayload.attachment;
    const previewQuery = new URLSearchParams({
      environment: "dev",
      sessionId: "session-image",
      storageRef: String(attachment.storageRef),
      id: String(attachment.id),
      mimeType: String(attachment.mimeType),
    });

    const previewResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/attachments?${previewQuery}`,
    );

    expect(uploadResponse.ok).toBe(true);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("content-type")).toBe("image/png");
    expect(previewResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(previewResponse.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(new Uint8Array(await previewResponse.arrayBuffer())).toEqual(bytes);

    previewQuery.set("sessionId", "different-session");
    const wrongOwnerResponse = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/attachments?${previewQuery}`,
    );
    expect(wrongOwnerResponse.status).toBe(404);
    await expect(wrongOwnerResponse.json()).resolves.toMatchObject({
      ok: false,
      error: "attachment_not_found",
    });
  });

  test("serves active request events before persisted replay is available", async () => {
    const release = deferred();
    mockedHandleRunRequest.mockImplementationOnce(async (ws, msg) => {
      ws.send(
        JSON.stringify({
          type: "event",
          requestId: msg.requestId,
          name: "Planning development work...",
          eventSequence: 1,
        }),
      );
      await release.promise;
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: msg.requestId,
          output: "ok",
        }),
      );
    });
    const backend = new LocalRuntimeWebBackend({
      rootDir,
      defaultEnvironmentId: "prod",
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const port = await listen(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          sessionId: "session-active",
          environment: "dev",
          taskType: "development",
        }),
      },
    );
    const payload = (await response.json()) as Record<string, unknown>;
    const requestId = String(payload.requestId);

    await vi.waitFor(async () => {
      const eventsResponse = await fetch(
        `http://127.0.0.1:${port}/web-api/requests/${requestId}/events?environment=dev`,
      );
      const eventsPayload = (await eventsResponse.json()) as Record<
        string,
        unknown
      >;
      expect(eventsResponse.status).toBe(200);
      expect(eventsPayload).toMatchObject({
        ok: true,
        requestId,
        finalState: null,
      });
      expect(eventsPayload.events).toEqual([
        expect.objectContaining({
          name: "Planning development work...",
          eventSequence: 1,
        }),
      ]);
    });

    release.resolve();
  });
});
