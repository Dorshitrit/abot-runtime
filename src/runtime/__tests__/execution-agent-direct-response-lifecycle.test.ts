import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
} from "./support/root-invalid-output-fixture.js";
import { openAICompletionGateway } from "./support/openai-output-completion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  resetModelIoTraceConfig();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const respond = (response: string) => JSON.stringify({
  decision: { action: "respond", response, acknowledgement: "I will answer." },
});

test("discards a completed direct answer superseded by STEER before publishing", async () => {
  const steering = createRequestSteeringInbox({ requestId: "root-invalid-request" });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(input.modelStep).toBe("execution.decision");
    if (invoke.mock.calls.length === 1) {
      steering.append({ steerId: "new-direction", text: "Answer the updated question." });
      return { text: respond("STALE ANSWER"), meta: {} };
    }
    expect(JSON.stringify(input.messages)).toContain("Answer the updated question.");
    return { text: respond("The updated answer."), meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    requestSteering: steering,
  });

  const result = await runRequestRunner(request);

  expect(result.output).toBe("The updated answer.");
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision", "execution.decision",
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(result.output);
  expect(JSON.stringify(result)).not.toContain("STALE");
});

test("parent cancellation wins over a valid direct answer returned by the provider", async () => {
  const abort = new AbortController();
  const failure = new Error("cancelled_before_direct_answer_commit");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    abort.abort(failure);
    return { text: respond("Never publish this answer."), meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    abortSignal: abort.signal,
  });

  await expect(runRequestRunner(request)).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).not.toHaveBeenCalled();
});

test("provider exceptions do not become a direct answer or a response fallback", async () => {
  const failure = new Error("direct_answer_connection_failed");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => { throw failure; });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1");

  await expect(runRequestRunner(request)).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).not.toHaveBeenCalled();
});

test.each(["eof", "done"] as const)(
  "a syntactically complete direct answer ending at %s never publishes",
  async (ending) => {
    const fixture = await openAICompletionGateway([
      { text: respond("A complete-looking but uncommitted answer."), ending },
    ]);
    try {
      const request = createRootInvalidOutputRequest(fixture.invoke, "execution-agent-v1", {
        modelPolicy: fixture.modelPolicy,
        modelGatewayClient: fixture.modelGatewayClient,
      });
      const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
      await expect(runRootExecutionKernel({ request, ledger }))
        .rejects.toThrow("openai function response not completed");
      expect(request.onAnswerToken).not.toHaveBeenCalled();
      expect(ledger.current().state.results).toEqual([]);
      expect(fixture.invoke).toHaveBeenCalledOnce();
    } finally {
      await fixture.dispose();
    }
  },
);

test("the same direct answer from a completed provider response publishes once", async () => {
  const answer = "The terminal provider response completed.";
  const fixture = await openAICompletionGateway([{ text: respond(answer) }]);
  try {
    const request = createRootInvalidOutputRequest(fixture.invoke, "execution-agent-v1", {
      modelPolicy: fixture.modelPolicy,
      modelGatewayClient: fixture.modelGatewayClient,
    });
    await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision",
    ]);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
  } finally {
    await fixture.dispose();
  }
});
