import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayEvent } from "../../types.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createOpenAIProviderAdapter } from "../openai/adapter.js";
import { frame } from "../openai/__tests__/native-function-fixture.js";
import { completed, finalMessage, invoke, request, response } from "./__tests__/fixture.js";

afterEach(() => vi.unstubAllEnvs());
const delta = { type: "response.output_text.delta", item_id: "final", output_index: 0, delta: "answer" };
const terminals = [
  ["EOF", undefined, "", "not completed"],
  ["DONE", undefined, "data: [DONE]\n\n", "not completed"],
  ["incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, "", "incomplete"],
  ["failed", { type: "response.failed", response: { status: "failed", error: { message: "subscription_sharing_usage_limit_exceeded" } } }, "", "subscription_sharing_usage_limit_exceeded"],
  ["invalid completed status", { type: "response.completed", response: { status: "in_progress" } }, "", "not completed"],
] as const;

describe.each(["raw", "chat"] as const)("ChatGPT %s completion", (endpoint) => {
  test.each(terminals)("%s cannot report success after partial text", async (_name, terminal, suffix, message) => {
    const operation = invoke(async () => response([delta, ...(terminal ? [terminal] : [])], suffix), request, endpoint);
    if (endpoint === "raw") {
      await expect(operation).rejects.toThrow(message);
      return;
    }
    const result = await operation;
    if (result.kind !== "chat") throw new Error("expected chat");
    const events: ModelGatewayEvent[] = [];
    await result.stream({ emit: (event) => events.push(event) });
    expect(events).toEqual([{ type: "content", text: "answer" }, { type: "error", error: expect.stringContaining(message) }]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("completed response ends an open upstream HTTP body without waiting for EOF", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode([delta, completed].map(frame).join(""))); }, cancel,
    });
    const result = await invoke(async () => new Response(body), request, endpoint);
    if (result.kind === "raw") expect(result.body).toMatchObject({ text: "answer" });
    else if (result.kind === "chat") {
      const events: ModelGatewayEvent[] = [];
      await result.stream({ emit: (event) => events.push(event) });
      expect(events.at(-1)).toMatchObject({ type: "done", done: true });
    } else throw new Error("expected inference result");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

test.each([
  { modelStep: "supervisor.decision", format: { type: "json_schema", name: "supervisor", strict: true,
    schema: { type: "object", properties: { next: { type: "string" } }, required: ["next"], additionalProperties: false } } },
  { modelStep: "tool_payload.raw", format: { type: "text" } },
])("SUPER $modelStep keeps final-message selection and rejects provisional commentary", async (step) => {
  const commentary = { type: "message", id: "comment", phase: "commentary", content: [{ type: "output_text", text: "ignore" }] };
  const result = await invoke(async () => response([
    { type: "response.output_item.added", output_index: 0, item: commentary },
    { type: "response.output_text.delta", item_id: "comment", output_index: 0, delta: "ignore" },
    { type: "response.output_item.added", output_index: 1, item: finalMessage },
    { ...delta, output_index: 1 },
    { type: "response.completed", response: { status: "completed", output: [commentary, finalMessage] } },
  ]), { ...request, ...step });
  expect(result).toMatchObject({ kind: "raw", body: { text: "answer" } });
});

test("API-key ordinary text also rejects partial EOF without changing authentication transport", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  const requestBody = { ...request, modelPolicy: { ...request.modelPolicy!, providers: { plan: { type: "openai" } } } };
  const fetchImpl = vi.fn<typeof fetch>(async () => response([delta]));
  await expect(createOpenAIProviderAdapter().invoke({
    endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
  })).rejects.toThrow("not completed");
  expect(fetchImpl.mock.calls[0]![1]).not.toHaveProperty("redirect");
});
