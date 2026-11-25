import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelStepInvocationInput } from "../model/model-step-port.js";
import { routeFilePayloadAuthor } from "../request/execution-file-payload/author.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { filePayloadFixture, filePayloadInput } from "./support/execution-file-payload-fixture.js";
import { filePayloadOutput } from "./support/execution-file-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each(["\uFEFFשלום\r\n", "", "  without newline  "])("isolated file author preserves exact output bytes with one invocation: %j", async (body) => {
  const f = await filePayloadFixture();
  const invoke = vi.fn(async (input: ModelStepInvocationInput<unknown>) =>
    input.accept(filePayloadOutput(input.messages, body), { outputLength: body.length, providerCompletionReason: "stop" }, f.request.abortSignal));
  const legacy = { author: vi.fn() };
  const author = routeFilePayloadAuthor({ ...f.request, modelSteps: { invoke } } as typeof f.request,
    legacy, resolveRequestExecutionPolicy("execution-agent-v1").authority);
  await expect(author.author(filePayloadInput())).resolves.toEqual({ status: "authored", body });
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke.mock.calls[0]![0]).toMatchObject({ modelStep: "execution.file_payload.raw", boundSteeringVersion: 0 });
  expect(invoke.mock.calls[0]![0]).not.toHaveProperty("format");
  expect(invoke.mock.calls[0]![0]).not.toHaveProperty("contextRetention");
  expect(invoke.mock.calls[0]![0].contextCompaction).toBeDefined();
  expect(legacy.author).not.toHaveBeenCalled();
});

test("SUPER source-bound requests are rejected and ordinary legacy payloads pass through unchanged", async () => {
  const f = await filePayloadFixture();
  const legacy = { author: vi.fn(async () => ({ status: "authored" as const, body: "LEGACY_BYTES" })) };
  const author = routeFilePayloadAuthor(f.request, legacy,
    resolveRequestExecutionPolicy("supervisor-worker-v1").authority);
  await expect(author.author(filePayloadInput())).resolves.toEqual({ status: "failed", code: "payload_context_invalid" });
  const { preparedPayload: _prepared, ...ordinary } = filePayloadInput();
  await expect(author.author(ordinary)).resolves.toEqual({ status: "authored", body: "LEGACY_BYTES" });
  expect(legacy.author).toHaveBeenCalledExactlyOnceWith(ordinary);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("invalid exact-edit output returns once without hidden model repair", async () => {
  const f = await filePayloadFixture();
  f.invoke.mockImplementation(async (input) => ({ text: filePayloadOutput(input.messages, '{"edits":[],"edits":[]}'), meta: {} }));
  const author = routeFilePayloadAuthor(f.request, { author: vi.fn() },
    resolveRequestExecutionPolicy("execution-agent-v1").authority);
  const input = filePayloadInput();
  await expect(author.author({ ...input, preparedPayload: { ...input.preparedPayload!, responseFormat: "json" } }))
    .resolves.toEqual({ status: "failed", code: "payload_model_output_invalid" });
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("oversized exact source is rejected by the existing context manager before authoring", async () => {
  const f = await filePayloadFixture();
  f.countInputTokens.mockResolvedValue({ inputTokens: 50_000, profileId: "test", provider: "openai",
    model: "test", contextWindowTokens: 32_000, source: "provider_input_token_count" });
  const author = routeFilePayloadAuthor(f.request, { author: vi.fn() },
    resolveRequestExecutionPolicy("execution-agent-v1").authority);
  await expect(author.author(filePayloadInput())).resolves.toMatchObject({ status: "failed", code: "payload_context_budget_exceeded" });
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each([
  { label: "plugin byte limit", body: "oversized", reason: "stop", maxBytes: 3, code: "payload_body_too_large" },
  { label: "incomplete output", body: "partial", reason: "length", maxBytes: 100, code: "payload_model_invocation_failed" },
])("$label fails once without a repair request", async ({ body, reason, maxBytes, code }) => {
  const f = await filePayloadFixture();
  const invoke = vi.fn(async (input: ModelStepInvocationInput<unknown>) =>
    input.accept(filePayloadOutput(input.messages, body), { outputLength: body.length, providerCompletionReason: reason }, f.request.abortSignal));
  const author = routeFilePayloadAuthor({ ...f.request, modelSteps: { invoke } } as typeof f.request,
    { author: vi.fn() }, resolveRequestExecutionPolicy("execution-agent-v1").authority);
  const input = filePayloadInput();
  await expect(author.author({ ...input, preparedPayload: { ...input.preparedPayload!,
    context: { ...input.preparedPayload!.context, maxBytes } } }))
    .resolves.toEqual({ status: "failed", code });
  expect(invoke).toHaveBeenCalledOnce();
});
