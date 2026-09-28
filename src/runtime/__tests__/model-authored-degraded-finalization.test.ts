import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { buildDegradedFinalizationModelInput } from "../steps/degraded-finalization/input.js";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import type { DegradedFinalizationInput } from "../steps/degraded-finalization/contract.js";
import { runModelAuthoredDegradedFinalization } from "../steps/degraded-finalization/model-authored.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";

const input: DegradedFinalizationInput = {
  problem: { stage: "decision", code: "invalid_supervisor_decision" },
  progress: null,
};
const phrasing = {
  failureNotice: "I could not finish this request reliably.",
  nextStep: "Continue from the established state.",
};
const authoredOutput = `${phrasing.failureNotice}\n\n${phrasing.nextStep}`;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("returns the exact accepted model phrasing through the existing degraded step", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify(phrasing),
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke);

  await expect(
    runModelAuthoredDegradedFinalization({
      request,
      input,
      maxResponseChars: 500,
    }),
  ).resolves.toBe(authoredOutput);
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke.mock.calls[0]![0]).toMatchObject({
    modelStep: "degraded.finalization",
    format: {
      type: "json_schema",
      name: "degraded_finalization",
      strict: true,
    },
  });
  expect(request.onAnswerToken).not.toHaveBeenCalled();
});

test("allows only the existing two repairs and returns the model's final valid attempt", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  invoke
    .mockResolvedValueOnce({ text: "not JSON", meta: {} })
    .mockResolvedValueOnce({
      text: JSON.stringify({ failureNotice: "", nextStep: "" }),
      meta: {},
    })
    .mockResolvedValueOnce({ text: JSON.stringify(phrasing), meta: {} });
  const request = createRootInvalidOutputRequest(invoke);

  await expect(
    runModelAuthoredDegradedFinalization({
      request,
      input,
      maxResponseChars: 500,
    }),
  ).resolves.toBe(authoredOutput);
  expect(invoke.mock.calls.map(([call]) => call.modelStep)).toEqual(
    Array<string>(3).fill("degraded.finalization"),
  );
  const originalMessages = invoke.mock.calls[0]![0].messages as ChatMessage[];
  for (const [call] of invoke.mock.calls.slice(1)) {
    const messages = call.messages as ChatMessage[];
    expect(messages.slice(0, originalMessages.length)).toEqual(
      originalMessages,
    );
    expect(messages).toHaveLength(originalMessages.length + 1);
    expect(messages.at(-1)?.role).toBe("system");
  }
});

test.each([
  ["malformed JSON", "not JSON"],
  ["blank output", "  "],
  ["blank phrasing", JSON.stringify({ failureNotice: " ", nextStep: "Next." })],
  [
    "overlong phrasing",
    JSON.stringify({ failureNotice: "x".repeat(501), nextStep: "Next." }),
  ],
] as const)(
  "exhausts %s without returning a fixed substitute",
  async (_, text) => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text,
      meta: {},
    }));
    const request = createRootInvalidOutputRequest(invoke);
    const result = runModelAuthoredDegradedFinalization({
      request,
      input,
      maxResponseChars: 500,
    });

    await expect(result).rejects.toBeInstanceOf(
      StructuredModelInvalidOutputError,
    );
    await expect(result).rejects.toMatchObject({
      message: "invalid_degraded_finalization_output",
      modelStep: "degraded.finalization",
      repairAttempts: 2,
      repeatedInvalidOutput: true,
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(request.onAnswerToken).not.toHaveBeenCalled();
  },
);

test("the response ceiling includes canonical progress and never drops progress to fit", async () => {
  const progress: DegradedFinalizationInput = {
    ...input,
    progress: {
      planSummary: "Recorded work",
      completed: [{ id: "write", title: "Recorded established result" }],
      unresolved: [
        {
          id: "verify",
          title: "Verification remains pending",
          status: "pending",
        },
      ],
    },
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify(phrasing),
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke);

  await expect(
    runModelAuthoredDegradedFinalization({
      request,
      input: progress,
      maxResponseChars: authoredOutput.length,
    }),
  ).rejects.toMatchObject({
    message: "invalid_degraded_finalization_output",
    repairAttempts: 2,
  });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(progress.progress?.completed).toEqual([
    { id: "write", title: "Recorded established result" },
  ]);
});

test("a provider failure propagates immediately without output repair or substitution", async () => {
  const failure = new Error("degraded_provider_connection_failed");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    throw failure;
  });
  const request = createRootInvalidOutputRequest(invoke);

  await expect(
    runModelAuthoredDegradedFinalization({
      request,
      input,
      maxResponseChars: 500,
    }),
  ).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).not.toHaveBeenCalled();
});

test("cancellation prevents malformed degraded output from entering repair", async () => {
  const abort = new AbortController();
  const failure = new Error("user_cancelled_degraded_finalization");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    abort.abort(failure);
    return { text: "invalid", meta: {} };
  });
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    {
      abortSignal: abort.signal,
    },
  );

  await expect(
    runModelAuthoredDegradedFinalization({
      request,
      input,
      maxResponseChars: 500,
    }),
  ).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).not.toHaveBeenCalled();
});

test("degraded repairs use the latest accepted user update without rewriting the request", async () => {
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  const earlierUpdate = "Continue with the existing result.";
  const latestUpdate = "Por favor, explica el problema en español.";
  expect(steering.append({ steerId: "earlier", text: earlierUpdate }).ok).toBe(
    true,
  );
  expect(steering.append({ steerId: "latest", text: latestUpdate }).ok).toBe(
    true,
  );
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  invoke.mockResolvedValueOnce({ text: "invalid", meta: {} });
  invoke.mockResolvedValueOnce({ text: JSON.stringify(phrasing), meta: {} });
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    {
      requestSteering: steering,
    },
  );
  const originalPrompt = request.prompt;

  await expect(
    runModelAuthoredDegradedFinalization({
      request,
      input,
      maxResponseChars: 500,
    }),
  ).resolves.toBe(authoredOutput);
  for (const [call] of invoke.mock.calls) {
    const messages = call.messages as ChatMessage[];
    expect(messages.filter(({ role }) => role === "user")).toHaveLength(1);
    const userContent = messages.find(({ role }) => role === "user")!.content;
    expect(userContent).toContain(latestUpdate);
    expect(userContent).not.toContain(earlierUpdate);
    expect(userContent).not.toContain(originalPrompt);
  }
  expect(request.prompt).toBe(originalPrompt);
  // The legacy caller keeps its original input even when steering exists.
  const legacyInput = buildDegradedFinalizationModelInput({ request, input });
  expect(legacyInput.messages[1]!.content).toContain(originalPrompt);
  expect(legacyInput.messages[1]!.content).not.toContain(latestUpdate);
});

test("without accepted updates the degraded model input is unchanged", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify(phrasing),
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke);
  const expected = buildDegradedFinalizationModelInput({ request, input });
  await runModelAuthoredDegradedFinalization({
    request,
    input,
    maxResponseChars: 500,
  });
  expect(invoke.mock.calls[0]![0].messages).toEqual(expected.messages);
  expect(invoke.mock.calls[0]![0].format).toEqual(expected.format);
});
