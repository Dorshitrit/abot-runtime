import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  configureModelIoTrace,
  fetchProviderWithTrace,
  resetModelIoTraceConfig,
  traceModelIo,
  type ModelIoTraceEvent,
} from "../model-io-trace.js";
import { resolveModelInvocation } from "../invocation-policy.js";

const tempRoots: string[] = [];

function createEvent(
  invocationId: string,
  body: Record<string, unknown>,
): ModelIoTraceEvent {
  return {
    event: "provider.request",
    invocationId,
    requestId: "request-עברית",
    endpoint: "chat",
    modelStep: "planner.decision",
    profileId: "test-profile",
    providerId: "ollama",
    provider: "ollama",
    model: "test-model",
    request: {
      body,
    },
  };
}

afterEach(async () => {
  resetModelIoTraceConfig();
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("model I/O trace", () => {
  test("preserves full payloads and serializes concurrent writes", async () => {
    const rootDir = join(tmpdir(), `model-io-trace-${randomUUID()}`);
    const traceFile = join(rootDir, "model-io.jsonl");
    tempRoots.push(rootDir);
    configureModelIoTrace({
      traceFile,
      enabled: true,
      rotation: {
        maxFileSizeMb: 20,
        maxFiles: 10,
        maxAgeDays: 7,
      },
    });
    const firstPayload = {
      messages: [
        {
          role: "system",
          content: "All system instructions\nremain intact.",
        },
        {
          role: "user",
          content: "שלום 🌍",
        },
      ],
      format: {
        type: "object",
        properties: {
          action: { type: "string" },
        },
      },
      options: {
        num_ctx: 32_768,
      },
    };

    await Promise.all([
      traceModelIo(createEvent("invocation-1", firstPayload)),
      traceModelIo(createEvent("invocation-2", { prompt: "second" })),
    ]);

    const entries = (await readFile(traceFile, "utf-8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      version: 1,
      event: "provider.request",
      invocationId: "invocation-1",
      requestId: "request-עברית",
    });
    expect(
      (entries[0].request as { body: Record<string, unknown> }).body,
    ).toEqual(firstPayload);
    expect(entries[1]).toMatchObject({
      invocationId: "invocation-2",
    });
  });

  test("uses the shared runtime rotation mechanism", async () => {
    const rootDir = join(tmpdir(), `model-io-rotation-${randomUUID()}`);
    const traceFile = join(rootDir, "model-io.jsonl");
    tempRoots.push(rootDir);
    configureModelIoTrace({
      traceFile,
      enabled: true,
      rotation: {
        maxFileSizeMb: 0.000_1,
        maxFiles: 1,
        maxAgeDays: 7,
      },
    });

    await traceModelIo(
      createEvent("rotation-1", {
        prompt: "x".repeat(256),
      }),
    );
    await traceModelIo(
      createEvent("rotation-2", {
        prompt: "second",
      }),
    );

    const names = await readdir(rootDir);
    expect(names).toContain("model-io.jsonl");
    expect(
      names.filter(
        (name) =>
          name !== "model-io.jsonl" &&
          name.startsWith("model-io.") &&
          name.endsWith(".jsonl"),
      ),
    ).toHaveLength(1);
    expect(await readFile(traceFile, "utf-8")).toContain(
      '"invocationId":"rotation-2"',
    );
  });

  test("does not clone or consume responses when tracing is disabled", async () => {
    configureModelIoTrace({
      traceFile: join(tmpdir(), `disabled-${randomUUID()}.jsonl`),
      enabled: false,
    });
    const requestBody = {
      text: "do not trace",
      modelPolicy: {
        providers: {
          ollama: { type: "ollama" as const },
        },
        profiles: {
          "test-profile": {
            provider: "ollama",
            model: "test-model",
            contextWindowTokens: 32_768,
          },
        },
        defaults: {
          profileId: "test-profile",
        },
      },
    };
    const invocation = resolveModelInvocation(requestBody);
    let cloneCalled = false;
    const response = new Response();
    vi.spyOn(response, "clone").mockImplementation(() => {
      cloneCalled = true;
      throw new Error("response must not be cloned");
    });

    const result = await fetchProviderWithTrace({
      endpoint: "chat",
      requestBody,
      invocation,
      fetchImpl: async () => response,
      url: "http://provider.test/chat",
      headers: {
        "Content-Type": "application/json",
      },
      payload: {
        messages: [{ role: "user", content: "do not trace" }],
      },
      decodeResponse: async () => ({ text: "", thinking: "" }),
    });
    await result.responseTrace;

    expect(result.response).toBe(response);
    expect(cloneCalled).toBe(false);
  });
});
