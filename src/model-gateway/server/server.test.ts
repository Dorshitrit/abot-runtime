import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  processDebugLogger,
  resetDebugLoggerConfig,
} from "../../runtime/observability/debug-logger.js";
import { REQUEST_INVOKED_STEP_IDS } from "../../runtime/config/runner/contracts.js";
import { resetModelIoTraceConfig } from "../model-io-trace.js";
import {
  createChatHandler,
  createModelGatewayServer,
  createRawHandler,
  type GatewayResponse,
} from "../server.js";

const tempRoots: string[] = [];

const SERVER_MODEL_POLICY = {
  providers: {
    ollama: { type: "ollama" as const },
  },
  profiles: {
    configured: {
      provider: "ollama",
      model: "configured-model",
      contextWindowTokens: 32_768,
      supportsThinking: true,
    },
  },
  defaults: {
    profileId: "configured",
  },
};

const TRACE_MODEL_POLICY = {
  providers: {
    ollama: { type: "ollama" as const },
  },
  profiles: {
    "trace-test": {
      provider: "ollama",
      model: "trace-test-model",
      contextWindowTokens: 16_384,
      options: {
        num_ctx: 16_384,
      },
      calibration: {
        "planner.decision": {
          instructions: ["System instruction one.", "System instruction two."],
        },
      },
    },
  },
  defaults: {
    profileId: "trace-test",
    steps: {
      "planner.decision": "planner.decision",
    },
  },
};

const OPENAI_MODEL_POLICY = {
  providers: {
    openai: {
      type: "openai" as const,
      apiKeyEnv: "TEST_MODEL_IO_API_KEY",
    },
  },
  profiles: {
    "openai-test": {
      provider: "openai",
      model: "gpt-test",
      contextWindowTokens: 32_768,
    },
  },
  defaults: {
    profileId: "openai-test",
  },
};

const PROJECTION_MODEL_POLICY = {
  providers: {
    ollama: { type: "ollama" as const },
  },
  profiles: {
    "projection-test": {
      provider: "ollama",
      model: "projection-test-model",
      contextWindowTokens: 12_345,
      options: {
        num_ctx: 12_345,
      },
    },
  },
  defaults: {
    profileId: "projection-test",
  },
};

function buildRequestRunnerConfig(defaultProfileId: string) {
  const modelSteps = Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, defaultProfileId]),
  );
  const steps = Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, { timeoutMs: 1000 }]),
  );
  return {
    models: {
      defaults: {
        profileId: defaultProfileId,
        steps: modelSteps,
      },
    },
    context: {
      outputReserveTokens: 1024,
      safetyReserveTokens: 256,
      attachmentReserveTokens: 256,
    },
    steps,
  };
}

function createCaptureResponse(): GatewayResponse & {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: "",
    headers: {},
    setHeader(name: string, value: string): void {
      this.headers[name] = value;
    },
    write(chunk: string): void {
      this.body += chunk;
    },
    end(chunk = ""): void {
      this.body += chunk;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
  resetModelIoTraceConfig();
  delete process.env.MODEL_GATEWAY_TRACE_FILE;
  delete process.env.MODEL_GATEWAY_MODEL_IO_TRACE_FILE;
  delete process.env.TEST_MODEL_IO_API_KEY;
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("model gateway configured catalog", () => {
  test("loads /models profiles and default from runtime and request-runner config", async () => {
    const rootDir = join(tmpdir(), `llm-runtime-model-catalog-${randomUUID()}`);
    tempRoots.push(rootDir);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: {
          providers: {
            local: {
              type: "ollama",
              baseUrl: "http://configured-provider.test",
            },
          },
          profiles: {
            "catalog-primary": {
              label: "Primary",
              provider: "local",
              model: "primary-model",
              contextWindowTokens: 32_768,
            },
            "catalog-secondary": {
              label: "Secondary",
              provider: "local",
              model: "secondary-model",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
      }),
      "utf-8",
    );
    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(buildRequestRunnerConfig("catalog-secondary")),
      "utf-8",
    );

    const previousCwd = process.cwd();
    let server: ReturnType<typeof createModelGatewayServer> | null = null;
    try {
      process.chdir(rootDir);
      server = createModelGatewayServer();
      const boundServer = server;
      await new Promise<void>((resolve) => boundServer.listen(0, resolve));
      const address = boundServer.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/models`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        defaultProfileId: "catalog-secondary",
        profiles: [
          {
            id: "catalog-primary",
            label: "Primary",
            providerId: "local",
            provider: "ollama",
            model: "primary-model",
          },
          {
            id: "catalog-secondary",
            label: "Secondary",
            providerId: "local",
            provider: "ollama",
            model: "secondary-model",
          },
        ],
      });
    } finally {
      process.chdir(previousCwd);
      if (server) {
        const boundServer = server;
        await new Promise<void>((resolve, reject) =>
          boundServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });
});

describe("model gateway provider cancellation", () => {
  test.each(["chat", "raw"] as const)(
    "propagates a disconnected %s client to the provider fetch",
    async (endpoint) => {
      const rootDir = join(
        tmpdir(),
        `llm-runtime-provider-abort-${endpoint}-${randomUUID()}`,
      );
      tempRoots.push(rootDir);
      await mkdir(rootDir, { recursive: true });
      await writeFile(
        join(rootDir, "runtime.config.json"),
        JSON.stringify({
          logging: { enabled: false },
          models: SERVER_MODEL_POLICY,
          requestRunner: {
            configRef: "./request-runner.config.json",
          },
        }),
        "utf-8",
      );
      await writeFile(
        join(rootDir, "request-runner.config.json"),
        JSON.stringify(buildRequestRunnerConfig("configured")),
        "utf-8",
      );

      let markProviderStarted: () => void = () => {};
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      let markProviderAborted: () => void = () => {};
      const providerAborted = new Promise<void>((resolve) => {
        markProviderAborted = resolve;
      });
      let providerSignal: AbortSignal | undefined;
      const previousCwd = process.cwd();
      let server: ReturnType<typeof createModelGatewayServer> | null = null;

      try {
        process.chdir(rootDir);
        server = createModelGatewayServer({
          modelPolicy: SERVER_MODEL_POLICY,
          fetchImpl: async (_url, init) => {
            providerSignal = init?.signal ?? undefined;
            markProviderStarted();
            return await new Promise<Response>((_resolve, reject) => {
              const rejectFromAbort = () => {
                markProviderAborted();
                reject(providerSignal?.reason);
              };
              if (providerSignal?.aborted) {
                rejectFromAbort();
                return;
              }
              providerSignal?.addEventListener("abort", rejectFromAbort, {
                once: true,
              });
            });
          },
        });
        const boundServer = server;
        await new Promise<void>((resolve) => boundServer.listen(0, resolve));
        const address = boundServer.address();
        if (!address || typeof address === "string") {
          throw new Error("failed to bind test server");
        }

        const clientAbort = new AbortController();
        const responsePromise = fetch(
          `http://127.0.0.1:${address.port}/${endpoint}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              debugRequestId: `provider-abort-${endpoint}`,
              modelStep: "worker.decision",
              ...(endpoint === "chat"
                ? {
                    messages: [
                      { role: "user", content: "wait for cancellation" },
                    ],
                  }
                : { prompt: "wait for cancellation" }),
            }),
            signal: clientAbort.signal,
          },
        );
        const rejectedResponse = expect(responsePromise).rejects.toMatchObject({
          name: "AbortError",
        });

        await providerStarted;
        clientAbort.abort();
        await rejectedResponse;
        await providerAborted;

        expect(providerSignal?.aborted).toBe(true);
        expect(providerSignal?.reason).toMatchObject({
          name: "AbortError",
          message: "model_gateway_client_disconnected:response_closed",
        });
      } finally {
        process.chdir(previousCwd);
        if (server) {
          const boundServer = server;
          await new Promise<void>((resolve, reject) => {
            boundServer.close((error) => (error ? reject(error) : resolve()));
            boundServer.closeAllConnections();
          });
        }
      }
    },
  );
});

describe("model gateway server logging", () => {
  test("records bounded Ollama repetition progress and the effective num_predict", async () => {
    const rootDir = join(
      tmpdir(),
      `llm-runtime-ollama-stream-diagnostics-${randomUUID()}`,
    );
    tempRoots.push(rootDir);
    const traceFile = join(rootDir, "model-gateway.jsonl");
    configureDebugLogger({ traceFile, enabled: true });
    const repeatedContent = "repeat-loop-".repeat(400);
    const providerBody = [
      JSON.stringify({
        message: { content: repeatedContent },
        done: false,
      }),
      JSON.stringify({
        done: true,
        done_reason: "stop",
        prompt_eval_count: 20,
        eval_count: 500,
      }),
      "",
    ].join("\n");
    const handler = createChatHandler({
      modelPolicy: SERVER_MODEL_POLICY,
      fetchImpl: async () =>
        new Response(providerBody, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
    });

    await handler(
      {
        debugRequestId: "ollama-repetition-diagnostics",
        modelStep: "worker.decision",
        messages: [{ role: "user", content: "produce output" }],
      },
      createCaptureResponse(),
    );
    await processDebugLogger.drain();

    const entries = (await readFile(traceFile, "utf-8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const progress = entries.find(
      (entry) => entry.event === "ollama.stream.progress",
    );
    const terminated = entries.find(
      (entry) => entry.event === "ollama.stream.terminated",
    );
    expect(progress).toMatchObject({
      requestId: "ollama-repetition-diagnostics",
      modelStep: "worker.decision",
      numPredict: expect.any(Number),
      contentCharacterCount: repeatedContent.length,
      contentRepeatedSuffixCount: expect.any(Number),
    });
    expect(terminated).toMatchObject({
      requestId: "ollama-repetition-diagnostics",
      outcome: "completed",
      abortRequested: false,
      numPredict: expect.any(Number),
      contentCharacterCount: repeatedContent.length,
      contentRepeatedSuffixCount: expect.any(Number),
    });
  });

  test("records the exact Ollama provider payload and raw response separately", async () => {
    const rootDir = join(tmpdir(), `llm-runtime-model-io-${randomUUID()}`);
    tempRoots.push(rootDir);

    const compactTraceFile = join(
      rootDir,
      ".runtime",
      "shared",
      "logs",
      "model-gateway.jsonl",
    );
    const modelIoTraceFile = join(
      rootDir,
      ".runtime",
      "shared",
      "logs",
      "model-io.jsonl",
    );
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: SERVER_MODEL_POLICY,
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
      }),
      "utf-8",
    );

    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(buildRequestRunnerConfig("configured")),
      "utf-8",
    );

    const rawProviderResponse = [
      JSON.stringify({
        message: { thinking: "inspect ", content: "com" },
        done: false,
      }),
      JSON.stringify({
        message: { thinking: "context", content: "plete" },
        done: false,
      }),
      JSON.stringify({
        done: true,
        done_reason: "stop",
        prompt_eval_count: 120,
        eval_count: 8,
      }),
      "",
    ].join("\n");
    let providerRequestBody = "";
    const previousCwd = process.cwd();
    let server: ReturnType<typeof createModelGatewayServer> | null = null;

    try {
      process.chdir(rootDir);
      server = createModelGatewayServer({
        modelPolicy: TRACE_MODEL_POLICY,
        fetchImpl: async (_url, init) => {
          providerRequestBody = String(init?.body ?? "");
          return new Response(rawProviderResponse, {
            status: 200,
            headers: {
              "Content-Type": "application/x-ndjson",
            },
          });
        },
      });
      const boundServer = server;
      await new Promise<void>((resolve) => boundServer.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          debugRequestId: "full-model-io-test",
          modelStep: "planner.decision",
          messages: [
            {
              role: "user",
              content: "Inspect the full request.\nDo not omit context.",
            },
          ],
          modelPolicy: {
            providers: {
              ollama: {
                type: "ollama",
              },
            },
            profiles: {
              "request-override": {
                provider: "ollama",
                model: "request-override-model",
                contextWindowTokens: 32_768,
              },
            },
            defaults: {
              profileId: "request-override",
            },
          },
          format: {
            type: "json_schema",
            name: "decision",
            schema: {
              type: "object",
              properties: {
                action: { type: "string" },
              },
              required: ["action"],
              additionalProperties: false,
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const clientStream = await response.text();
      expect(clientStream).toContain('"text":"com"');
      expect(clientStream).toContain('"text":"plete"');

      const entries = (await readFile(modelIoTraceFile, "utf-8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toHaveLength(2);
      const requestEntry = entries[0];
      const responseEntry = entries[1];
      expect(requestEntry).toMatchObject({
        event: "provider.request",
        requestId: "full-model-io-test",
        endpoint: "chat",
        modelStep: "planner.decision",
        provider: "ollama",
        model: "trace-test-model",
      });
      expect(responseEntry).toMatchObject({
        event: "provider.response",
        invocationId: requestEntry.invocationId,
        response: {
          status: 200,
          decoded: {
            text: "complete",
            thinking: "inspect context",
            usage: {
              inputTokens: 120,
              outputTokens: 8,
              totalTokens: 128,
            },
          },
          body: rawProviderResponse,
        },
      });
      const tracedProviderBody = (
        requestEntry.request as {
          body: Record<string, unknown>;
        }
      ).body;
      expect(tracedProviderBody).toEqual(
        JSON.parse(providerRequestBody) as Record<string, unknown>,
      );
      expect(tracedProviderBody.messages).toEqual([
        {
          role: "system",
          content: "System instruction one.\nSystem instruction two.",
        },
        {
          role: "user",
          content: "Inspect the full request.\nDo not omit context.",
        },
      ]);
      expect(tracedProviderBody).toMatchObject({
        model: "trace-test-model",
        stream: true,
        options: {
          num_ctx: 16_384,
        },
        format: {
          type: "object",
          properties: {
            action: { type: "string" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const compactTrace = await readFile(compactTraceFile, "utf-8");
      expect(compactTrace).not.toContain("System instruction one.");
      expect(compactTrace).not.toContain("Inspect the full request.");
    } finally {
      process.chdir(previousCwd);
      if (server) {
        const boundServer = server;
        await new Promise<void>((resolve, reject) =>
          boundServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  test("does not persist provider credentials in the full trace", async () => {
    const rootDir = join(tmpdir(), `llm-runtime-model-io-auth-${randomUUID()}`);
    tempRoots.push(rootDir);
    const modelIoTraceFile = join(
      rootDir,
      ".runtime",
      "shared",
      "logs",
      "model-io.jsonl",
    );
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: SERVER_MODEL_POLICY,
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
      }),
      "utf-8",
    );
    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(buildRequestRunnerConfig("configured")),
      "utf-8",
    );
    process.env.TEST_MODEL_IO_API_KEY = "must-not-enter-trace";
    let authorizationHeader = "";
    const previousCwd = process.cwd();
    let server: ReturnType<typeof createModelGatewayServer> | null = null;

    try {
      process.chdir(rootDir);
      server = createModelGatewayServer({
        modelPolicy: OPENAI_MODEL_POLICY,
        fetchImpl: async (_url, init) => {
          authorizationHeader =
            new Headers(init?.headers).get("Authorization") ?? "";
          return new Response(
            [
              'data: {"type":"response.output_text.delta","delta":"ok"}',
              "",
              'data: {"type":"response.completed","response":{}}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
              },
            },
          );
        },
      });
      const boundServer = server;
      await new Promise<void>((resolve) => boundServer.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/raw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "Return ok.",
          debugRequestId: "openai-model-io-test",
          modelStep: "worker.execution",
        }),
      });
      expect(response.status).toBe(200);
      expect(authorizationHeader).toBe("Bearer must-not-enter-trace");

      const trace = await readFile(modelIoTraceFile, "utf-8");
      expect(trace).toContain('"input":"Return ok."');
      expect(trace).not.toContain("must-not-enter-trace");
      expect(trace).not.toContain('"Authorization"');
      const entries = trace
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries[1]).toMatchObject({
        event: "provider.response",
        response: {
          decoded: {
            text: "ok",
            thinking: "",
          },
        },
      });
    } finally {
      process.chdir(previousCwd);
      if (server) {
        const boundServer = server;
        await new Promise<void>((resolve, reject) =>
          boundServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  test("writes shared gateway logs outside env-specific runtime logs", async () => {
    const rootDir = join(tmpdir(), `llm-runtime-gateway-${randomUUID()}`);
    tempRoots.push(rootDir);

    const traceFile = join(
      rootDir,
      ".runtime",
      "shared",
      "logs",
      "model-gateway.jsonl",
    );
    await mkdir(join(rootDir, ".runtime", "shared", "logs"), {
      recursive: true,
    });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: SERVER_MODEL_POLICY,
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
      }),
      "utf-8",
    );

    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(buildRequestRunnerConfig("configured")),
      "utf-8",
    );

    const previousCwd = process.cwd();
    let server: ReturnType<typeof createModelGatewayServer> | null = null;

    try {
      process.chdir(rootDir);
      server = createModelGatewayServer({
        modelPolicy: PROJECTION_MODEL_POLICY,
        fetchImpl: async () => {
          throw new Error("synthetic fetch failure");
        },
      });
      const boundServer = server;
      await new Promise<void>((resolve) => boundServer.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello from dev",
          debugRequestId: "schema-projection-log-test",
          modelStep: "reviewer.decision",
          format: {
            type: "json_schema",
            name: "bounded_output",
            postValidatedSchemaConstraints: [
              {
                keyword: "maxLength",
                path: "/properties/value/maxLength",
              },
            ],
            schema: {
              type: "object",
              properties: {
                value: { type: "string", maxLength: 32 },
              },
              required: ["value"],
              additionalProperties: false,
            },
          },
        }),
      });
      expect(response.status).toBe(500);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const raw = await readFile(traceFile, "utf-8");
      expect(raw).toContain('"scope":"model-gateway.server"');
      expect(raw).toContain('"event":"model.invocation.resolved"');
      expect(raw).toContain('"event":"provider.request.projected"');
      expect(raw).toContain('"event":"schema.projection.constraint_removed"');
      expect(raw).toContain('"requestId":"schema-projection-log-test"');
      expect(raw).toContain('"keyword":"maxLength"');
      expect(raw).toContain('"path":"/properties/value/maxLength"');
      const entries = raw
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const projected = entries.find(
        ({ event }) => event === "provider.request.projected",
      );
      expect(projected).toMatchObject({
        requestId: "schema-projection-log-test",
        modelStep: "reviewer.decision",
        provider: "ollama",
        requestedFormatKind: "json_schema",
        providerFormatKind: "schema",
        providerSchemaRootType: "object",
        providerSchemaRootPropertyCount: 1,
        providerSchemaRootOneOfVariantCount: 0,
        removedConstraintCount: 1,
        providerContextTokenLimit: 12_345,
        providerOutputTokenLimit: expect.any(Number),
      });
      expect(projected).not.toHaveProperty("schema");
      expect(projected).not.toHaveProperty("messages");
      expect(projected).not.toHaveProperty("text");
    } finally {
      process.chdir(previousCwd);
      if (server) {
        const boundServer = server;
        await new Promise<void>((resolve, reject) =>
          boundServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  test("uses runtime sharedDir for the default gateway trace file", async () => {
    const rootDir = join(tmpdir(), `llm-runtime-gateway-${randomUUID()}`);
    tempRoots.push(rootDir);

    const traceFile = join(
      rootDir,
      "runtime-shared",
      "logs",
      "model-gateway.jsonl",
    );
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: SERVER_MODEL_POLICY,
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
        paths: {
          sharedDir: "runtime-shared",
        },
      }),
      "utf-8",
    );

    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(buildRequestRunnerConfig("configured")),
      "utf-8",
    );

    const previousCwd = process.cwd();
    let server: ReturnType<typeof createModelGatewayServer> | null = null;

    try {
      process.chdir(rootDir);
      server = createModelGatewayServer({
        modelPolicy: SERVER_MODEL_POLICY,
        fetchImpl: async () => {
          throw new Error("synthetic fetch failure");
        },
      });
      const boundServer = server;
      await new Promise<void>((resolve) => boundServer.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello from shared logs",
        }),
      });
      expect(response.status).toBe(500);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const raw = await readFile(traceFile, "utf-8");
      expect(raw).toContain('"event":"model.invocation.resolved"');
    } finally {
      process.chdir(previousCwd);
      if (server) {
        const boundServer = server;
        await new Promise<void>((resolve, reject) =>
          boundServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });
});

describe("model gateway provider transport", () => {
  test("returns a clear client error for an unknown requested profile", async () => {
    let fetchCalled = false;
    const handler = createChatHandler({
      modelPolicy: SERVER_MODEL_POLICY,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("provider should not be called");
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        text: "hello",
        modelPreference: { profileId: "unknown-profile" },
      },
      res,
    );

    expect(fetchCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(
      "unknown_model_profile: requested profile unknown-profile is not available in model policy",
    );
  });

  test("keeps the first structured OpenAI output with correlated diagnostics", async () => {
    configureDebugLogger({ enabled: true });
    process.env.TEST_MODEL_IO_API_KEY = "test-openai-key";
    const decision = '{"decision":{"action":"return_result"}}';
    const ignoredDecision = '{"decision":{"action":"return_failure"}}';
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createChatHandler({
      fetchImpl: async () =>
        new Response(
          [
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              item_id: "message-1",
              output_index: 1,
              delta: decision,
            })}`,
            "",
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              item_id: "message-2",
              output_index: 3,
              delta: ignoredDecision,
            })}`,
            "",
            'data: {"type":"response.completed","response":{}}',
            "",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
    });
    const res = createCaptureResponse();

    await handler(
      {
        text: "Choose one decision.",
        debugRequestId: "structured-output-first-message-request",
        modelStep: "worker.decision",
        format: {
          type: "json_schema",
          name: "worker_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              decision: { type: "object" },
            },
            required: ["decision"],
            additionalProperties: false,
          },
        },
        modelPolicy: {
          providers: {
            openai: {
              type: "openai",
              apiKeyEnv: "TEST_MODEL_IO_API_KEY",
            },
          },
          profiles: {
            "openai-test": {
              provider: "openai",
              model: "gpt-test",
              contextWindowTokens: 32_768,
            },
          },
          defaults: {
            profileId: "openai-test",
          },
        },
      },
      res,
    );

    expect(res.body).toBe(
      `${JSON.stringify({ type: "content", text: decision })}\n` +
        `${JSON.stringify({ type: "done", done: true, doneReason: null })}\n`,
    );
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "model-gateway.server",
          event: "openai.message_outputs.normalized",
          requestId: "structured-output-first-message-request",
          modelStep: "worker.decision",
          endpoint: "chat",
          outcome: "additional_message_outputs_ignored",
          outputCount: 2,
          selectedOutput: {
            itemId: "message-1",
            outputIndex: 1,
            arrivalOrder: 1,
            textByteCount: Buffer.byteLength(decision, "utf8"),
          },
          ignoredOutputCount: 1,
          sampledIgnoredOutputs: [
            {
              itemId: "message-2",
              outputIndex: 3,
              arrivalOrder: 2,
              textByteCount: Buffer.byteLength(ignoredDecision, "utf8"),
            },
          ],
          omittedIgnoredOutputCount: 0,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(decision);
    expect(JSON.stringify(logs)).not.toContain(ignoredDecision);
  });

  test("chat uses the selected Ollama provider base URL from model policy", async () => {
    let requestedUrl = "";
    const handler = createChatHandler({
      ollamaUrl: "http://fallback-ollama.test",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: false,
          status: 502,
          body: null,
          text: async () => "expected failure",
        } as Response;
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        text: "hello",
        modelPolicy: {
          providers: {
            ollama: {
              type: "ollama",
              baseUrl: "http://configured-ollama.test",
            },
          },
          profiles: {
            "configured-ollama": {
              provider: "ollama",
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
          defaults: {
            profileId: "configured-ollama",
          },
        },
      },
      res,
    );

    expect(requestedUrl).toBe("http://configured-ollama.test/api/chat");
    expect(res.statusCode).toBe(502);
  });

  test("raw uses the selected Ollama provider base URL from model policy", async () => {
    let requestedUrl = "";
    const handler = createRawHandler({
      ollamaUrl: "http://fallback-ollama.test",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: false,
          status: 502,
          body: null,
          text: async () => "expected failure",
        } as Response;
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        text: "hello",
        modelPolicy: {
          providers: {
            ollama: {
              type: "ollama",
              baseUrl: "http://configured-ollama.test",
            },
          },
          profiles: {
            "configured-ollama": {
              provider: "ollama",
              model: "test-model",
              contextWindowTokens: 32_768,
            },
          },
          defaults: {
            profileId: "configured-ollama",
          },
        },
      },
      res,
    );

    expect(requestedUrl).toBe("http://configured-ollama.test/api/chat");
    expect(res.statusCode).toBe(502);
  });

  test("raw rejects image attachments because raw payloads are prompt-only", async () => {
    let fetchCalled = false;
    const handler = createRawHandler({
      fetchImpl: async () => {
        fetchCalled = true;
        return {
          ok: false,
          status: 502,
          body: null,
          text: async () => "unexpected",
        } as Response;
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        text: "describe",
        messages: [
          {
            role: "user",
            content: "describe",
            attachments: [
              {
                id: "att-1",
                kind: "image",
                mimeType: "image/png",
                storageRef: "session/request/image.png",
                data: "aW1hZ2U=",
              },
            ],
          },
        ],
        modelPolicy: {
          providers: {
            ollama: {
              type: "ollama",
            },
          },
          profiles: {
            vision: {
              provider: "ollama",
              model: "vision-model",
              contextWindowTokens: 32_768,
              capabilities: {
                inputModalities: ["text", "image"],
              },
            },
          },
          defaults: {
            profileId: "vision",
          },
        },
      },
      res,
    );

    expect(fetchCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("raw_image_attachments_not_supported");
  });

  test("validates image support against the resolved chat profile", async () => {
    let requestedUrl = "";
    const handler = createChatHandler({
      ollamaUrl: "http://fallback-ollama.test",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return {
          ok: false,
          status: 502,
          body: null,
          text: async () => "expected failure",
        } as Response;
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        modelStep: "chat.final",
        messages: [
          {
            role: "user",
            content: "describe",
            attachments: [
              {
                id: "att-1",
                kind: "image",
                mimeType: "image/png",
                storageRef: "session/request/image.png",
                data: "aW1hZ2U=",
              },
            ],
          },
        ],
        modelPolicy: {
          providers: {
            ollama: {
              type: "ollama",
              baseUrl: "http://vision-ollama.test",
            },
          },
          profiles: {
            "text-default": {
              provider: "ollama",
              model: "text-model",
              contextWindowTokens: 32_768,
            },
            "vision-chat": {
              provider: "ollama",
              model: "vision-model",
              contextWindowTokens: 32_768,
              capabilities: {
                inputModalities: ["text", "image"],
              },
            },
          },
          defaults: {
            profileId: "text-default",
            steps: {
              "chat.final": "vision-chat",
            },
          },
        },
      },
      res,
    );

    expect(requestedUrl).toBe("http://vision-ollama.test/api/chat");
    expect(res.statusCode).toBe(502);
  });

  test("rejects image attachments when the selected adapter lacks image support", async () => {
    let fetchCalled = false;
    const handler = createChatHandler({
      fetchImpl: async () => {
        fetchCalled = true;
        return {
          ok: false,
          status: 502,
          body: null,
          text: async () => "unexpected",
        } as Response;
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        messages: [
          {
            role: "user",
            content: "describe",
            attachments: [
              {
                id: "att-1",
                kind: "image",
                mimeType: "image/png",
                storageRef: "session/request/image.png",
                data: "aW1hZ2U=",
              },
            ],
          },
        ],
        modelPolicy: {
          providers: {
            openai: {
              type: "openai",
            },
          },
          profiles: {
            "openai-vision": {
              provider: "openai",
              model: "gpt-test",
              contextWindowTokens: 32_768,
              capabilities: {
                inputModalities: ["text", "image"],
              },
            },
          },
          defaults: {
            profileId: "openai-vision",
          },
        },
      },
      res,
    );

    expect(fetchCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("resolved_provider_does_not_support_image_input");
  });

  test("rejects image attachments that were not resolved to data", async () => {
    let fetchCalled = false;
    const handler = createChatHandler({
      fetchImpl: async () => {
        fetchCalled = true;
        return {
          ok: false,
          status: 502,
          body: null,
          text: async () => "unexpected",
        } as Response;
      },
    });
    const res = createCaptureResponse();

    await handler(
      {
        messages: [
          {
            role: "user",
            content: "describe",
            attachments: [
              {
                id: "att-1",
                kind: "image",
                mimeType: "image/png",
                storageRef: "session/request/image.png",
              },
            ],
          },
        ],
        modelPolicy: {
          providers: {
            ollama: {
              type: "ollama",
            },
          },
          profiles: {
            vision: {
              provider: "ollama",
              model: "vision-model",
              contextWindowTokens: 32_768,
              capabilities: {
                inputModalities: ["text", "image"],
              },
            },
          },
          defaults: {
            profileId: "vision",
          },
        },
      },
      res,
    );

    expect(fetchCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("image_attachment_data_required");
  });
});
