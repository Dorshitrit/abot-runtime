import { describe, expect, test, vi } from "vitest";

import { invokeModelStep } from "../model/invoke-step.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { appendRequestSteeringContext } from "../request/request-steering-context.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  createRequestSteeringInbox,
  REQUEST_STEERING_MESSAGE_KIND,
} from "../request/request-steering.js";

const TEST_MODEL_POLICY: NonNullable<RequestExecutionSeed["modelPolicy"]> = {
  providers: {
    "test-provider": {
      type: "ollama",
    },
  },
  profiles: {
    "test-profile": {
      provider: "test-provider",
      model: "test-model",
      contextWindowTokens: 8_000,
    },
  },
  defaults: {
    profileId: "test-profile",
  },
};

describe("request steering inbox", () => {
  test("orders, deduplicates, persists, and seals active-request updates", async () => {
    const inbox = createRequestSteeringInbox({ requestId: "request-1" });
    const persisted: string[] = [];

    expect(
      inbox.append({ steerId: "steer-1", text: "Use the compact layout" }),
    ).toMatchObject({ ok: true, duplicate: false });
    inbox.bindPersistence(async (update) => {
      persisted.push(update.text);
    });
    expect(
      inbox.append({ steerId: "steer-2", text: "Keep the existing colors" }),
    ).toMatchObject({ ok: true, duplicate: false });
    expect(
      inbox.append({ steerId: "steer-1", text: "Use the compact layout" }),
    ).toMatchObject({ ok: true, duplicate: true });
    expect(
      inbox.append({ steerId: "steer-1", text: "Use another layout" }),
    ).toEqual({ ok: false, reason: "steer_id_conflict" });

    const snapshot = inbox.snapshot();
    expect(snapshot).toEqual({
      version: 2,
      updates: [
        {
          steerId: "steer-1",
          sequence: 1,
          text: "Use the compact layout",
        },
        {
          steerId: "steer-2",
          sequence: 2,
          text: "Keep the existing colors",
        },
      ],
    });
    expect(inbox.seal(1)).toBe(false);
    expect(inbox.seal(2)).toBe(true);
    expect(
      inbox.append({ steerId: "steer-3", text: "Add one more section" }),
    ).toEqual({ ok: false, reason: "request_not_active" });

    await inbox.close();
    expect(persisted).toEqual([
      "Use the compact layout",
      "Keep the existing colors",
    ]);
  });

  test("projects updates as user authority without changing an empty context", () => {
    const messages = [{ role: "system" as const, content: "instructions" }];
    expect(
      appendRequestSteeringContext(messages, {
        version: 0,
        updates: [],
      }),
    ).toEqual(messages);

    const projected = appendRequestSteeringContext(messages, {
      version: 1,
      updates: [
        { steerId: "steer-1", sequence: 1, text: "Stop after this check" },
      ],
    });
    const payload = JSON.parse(projected.at(-1)?.content ?? "") as Record<
      string,
      unknown
    >;
    expect(projected.at(-1)?.role).toBe("user");
    expect(payload.kind).toBe(REQUEST_STEERING_MESSAGE_KIND);
    expect(payload.authority).toBe("user");
    expect(payload.updates).toEqual([
      { sequence: 1, text: "Stop after this check" },
    ]);
  });

  test("discards a model output superseded by a newly arrived update", async () => {
    const inbox = createRequestSteeringInbox({ requestId: "request-model" });
    let resolveFirst:
      | ((value: { text: string; meta: Record<string, unknown> }) => void)
      | undefined;
    const firstResponse = new Promise<{
      text: string;
      meta: Record<string, unknown>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const invoke = vi
      .fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockResolvedValueOnce({ text: "fresh", meta: {} });
    const request = createInvocationRequest({
      requestId: "request-model",
      modelStep: "supervisor.decision",
      invoke,
      requestSteering: inbox,
    });
    const accept = vi.fn((text: string) => text);
    const resultPromise = invokeModelStep({
      request,
      modelStep: "supervisor.decision",
      messages: [{ role: "system", content: "Decide" }],
      timeoutReason: "test_timeout",
      accept,
    });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    inbox.append({ steerId: "steer-new", text: "Use the new direction" });
    resolveFirst?.({ text: "stale", meta: {} });

    await expect(resultPromise).resolves.toBe("fresh");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith("fresh", expect.any(Object));
    const secondMessages = invoke.mock.calls[1]?.[0]?.messages as
      | { role: string; content: string }[]
      | undefined;
    const steeringPayload = JSON.parse(
      secondMessages?.at(-1)?.content ?? "",
    ) as Record<string, unknown>;
    expect(steeringPayload.kind).toBe(REQUEST_STEERING_MESSAGE_KIND);
    expect(steeringPayload.updates).toEqual([
      { sequence: 1, text: "Use the new direction" },
    ]);
  });

  test("defers a newly arrived update without changing an active Worker assignment", async () => {
    const inbox = createRequestSteeringInbox({ requestId: "request-worker" });
    let resolveWorker:
      | ((value: { text: string; meta: Record<string, unknown> }) => void)
      | undefined;
    const workerResponse = new Promise<{
      text: string;
      meta: Record<string, unknown>;
    }>((resolve) => {
      resolveWorker = resolve;
    });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(
      async () => workerResponse,
    );
    const request = createInvocationRequest({
      requestId: "request-worker",
      modelStep: "worker.decision",
      invoke,
      requestSteering: inbox,
    });
    const messages = [
      { role: "system" as const, content: "Perform only the delegated search" },
    ];
    const accept = vi.fn((text: string) => text);
    const resultPromise = invokeModelStep({
      request,
      modelStep: "worker.decision",
      messages,
      timeoutReason: "test_timeout",
      accept,
    });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    inbox.append({ steerId: "steer-save", text: "Save it to a dated file" });
    resolveWorker?.({ text: "search complete", meta: {} });

    await expect(resultPromise).resolves.toBe("search complete");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]?.messages).toEqual(messages);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(inbox.snapshot()).toMatchObject({ version: 1 });
  });

  test("rejects steering content that does not fit before model invocation", async () => {
    const inbox = createRequestSteeringInbox({ requestId: "request-budget" });
    inbox.append({ steerId: "steer-large", text: "x".repeat(20_000) });
    const invoke = vi.fn();
    const request = createInvocationRequest({
      requestId: "request-budget",
      modelStep: "supervisor.decision",
      invoke,
      requestSteering: inbox,
    });

    await expect(
      invokeModelStep({
        request,
        modelStep: "supervisor.decision",
        messages: [{ role: "system", content: "Decide" }],
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).rejects.toThrow("request_context_compaction_required");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("keeps thinking state step-local when a request-bound invoker is reused", async () => {
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      input.onThinking?.(`thinking-${invocation}`);
      return { text: `output-${invocation}`, meta: {} };
    });
    const thinkingTraces: Parameters<
      RequestExecutionSeed["onThinkingTrace"]
    >[0][] = [];
    const request = createInvocationRequest({
      requestId: "request-bound-invoker",
      modelStep: "worker.decision",
      invoke,
      onThinkingTrace: (trace) => thinkingTraces.push(trace),
    });
    const invoker = request.modelSteps;

    await expect(
      invoker.invoke({
        modelStep: "worker.decision",
        messages: [{ role: "system", content: "First" }],
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).resolves.toBe("output-1");
    await expect(
      invoker.invoke({
        modelStep: "worker.decision",
        messages: [{ role: "system", content: "Second" }],
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).resolves.toBe("output-2");

    expect(thinkingTraces).toEqual([
      {
        step: "worker.decision",
        status: "completed",
        text: "thinking-1",
      },
      {
        step: "worker.decision",
        status: "completed",
        text: "thinking-2",
      },
    ]);
  });
});

function createInvocationRequest(
  params: Readonly<{
    requestId: string;
    modelStep: "supervisor.decision" | "worker.decision";
    invoke: ModelGatewayClient["invoke"];
    requestSteering?: RequestExecutionSeed["requestSteering"];
    onThinkingTrace?: RequestExecutionSeed["onThinkingTrace"];
  }>,
) {
  return createTestRequestExecutionScope({
    requestId: params.requestId,
    sessionId: `${params.requestId}-session`,
    prompt: "Exercise one request-bound model step.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: {
        defaults: {
          profileId: "test-profile",
          steps: { [params.modelStep]: params.modelStep },
        },
      },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: { [params.modelStep]: { timeoutMs: 20_000 } },
    },
    agentMode: "reasoning",
    modelPolicy: TEST_MODEL_POLICY,
    modelGatewayClient: { invoke: params.invoke, invokeRaw: vi.fn() },
    ...(params.requestSteering
      ? { requestSteering: params.requestSteering }
      : {}),
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: params.onThinkingTrace ?? vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}
