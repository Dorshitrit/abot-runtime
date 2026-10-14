import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function respond(response?: unknown, title?: string): string {
  return JSON.stringify({
    decision: {
      action: "respond",
      acknowledgement: "I will answer the question.",
      ...(response === undefined ? {} : { response }),
      ...(title === undefined ? {} : { title }),
    },
  });
}

test("one decision publishes an exact short answer and title once without a response call", async () => {
  const answer = '  שלום.\n\n```json\n{"value":"quoted"}\n```\nסוף.\t';
  const timeline: string[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(input.modelStep).toBe("execution.decision");
    timeline.push("decision");
    return { text: respond(answer, "תשובה קצרה"), meta: {} };
  });
  const onSessionTitle = vi.fn(async () => { timeline.push("title"); });
  const onAnswerToken = vi.fn(() => { timeline.push("answer"); });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    prompt: "ענה בעברית.",
    shouldGenerateSessionTitle: true,
    onSessionTitle,
    onAnswerToken,
  });

  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: answer,
    outputTextMode: "exact",
  });

  expect(invoke).toHaveBeenCalledOnce();
  expect(request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
  expect(onSessionTitle).toHaveBeenCalledExactlyOnceWith("תשובה קצרה");
  expect(onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
  expect(timeline.indexOf("title")).toBeLessThan(timeline.indexOf("answer"));
});

test("direct answering retains prior conversation language and the exact current request once", async () => {
  const prompt = "סכם את העדפת השפה שלי.";
  const prior = "אני מעדיף הסברים קצרים בעברית.";
  const answer = "אתה מעדיף הסברים קצרים בעברית.";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(input.modelStep).toBe("execution.decision");
    const messages = input.messages as readonly { role: string; content: string }[];
    expect(messages.filter(({ role, content }) => role === "user" && content === prompt))
      .toHaveLength(1);
    expect(JSON.stringify(messages)).toContain(prior);
    return { text: respond(answer), meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    prompt,
    historyMessages: [
      { id: "prior-user", role: "user", content: prior, createdAt: "2026-10-12T09:00:00Z" },
      { id: "prior-answer", role: "assistant", content: "אענה בקצרה בעברית.", createdAt: "2026-10-12T09:00:01Z" },
    ],
  });

  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test("respond without a body explicitly defers to the existing response step", async () => {
  const answer = "  A complete deferred answer.\n";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
    text: input.modelStep === "execution.decision" ? respond() : answer,
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1");

  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: answer, outputTextMode: "exact",
  });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision", "execution.response",
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test.each([
  ["empty", ""],
  ["whitespace", " \n\t"],
  ["nonstring", 42],
  ["null", null],
  ["over the UTF-16 bound", "🙂".repeat(512) + "x"],
] as const)("rejects a %s direct body before publication and repairs the decision", async (_, body) => {
  const answer = "A valid replacement.";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>()
    .mockResolvedValueOnce({ text: respond(body), meta: {} })
    .mockResolvedValue({ text: respond(answer), meta: {} });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1");

  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision", "execution.decision",
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test("accepts exactly 1024 UTF-16 characters without truncating the body", async () => {
  const answer = "🙂".repeat(512);
  expect(answer.length).toBe(1024);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: respond(answer), meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1");

  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test("uses the lower canonical response limit instead of truncating a direct answer", async () => {
  const ledger = await createRootInvalidOutputLedger("execution-agent-v1", 8);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>()
    .mockResolvedValueOnce({ text: respond("123456789"), meta: {} })
    .mockResolvedValue({ text: respond("12345678"), meta: {} });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1");

  await expect(runRootExecutionKernel({ request, ledger })).resolves.toMatchObject({
    output: "12345678",
  });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision", "execution.decision",
  ]);
});
