import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  COMPACTION_FACT,
  compactContinuation,
  semanticContractFixture,
} from "../../../runtime/__tests__/support/semantic-compaction-contract-fixture.js";
import { createSemanticCompactionFormat } from "../../../runtime/context/semantic-compaction/format.js";
import { SEMANTIC_COMPACTION_TEXT_MAX_LENGTH } from "../../../runtime/context/semantic-compaction/contracts.js";
import { generateSemanticCompactionCandidate } from "../../../runtime/context/semantic-compaction/run.js";
import type { ModelGatewayJsonSchemaFormat, ModelGatewayRequest } from "../../types.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { isTextChatMessage } from "../../protocol/message-contract.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { nativeRequest, sse } from "./__tests__/native-function-fixture.js";

const continuation = compactContinuation();
const checkpointArguments = JSON.stringify({
  continuation, sourceDigests: { source_0: COMPACTION_FACT },
});
const functionCall = {
  type: "function_call", id: "fc_compaction", call_id: "compaction-1",
  name: "context_compaction", status: "completed", arguments: checkpointArguments,
};
const commentary = {
  type: "message", id: "commentary", phase: "commentary",
  content: [{ type: "output_text", text: JSON.stringify({
    continuation: compactContinuation({ currentState: "Unaccepted commentary checkpoint." }),
    sourceDigests: { source_0: "Unaccepted commentary evidence." },
  }) }],
};
const provisionalEvents = [
  { type: "response.output_item.added", output_index: 0, item: commentary },
  { type: "response.output_text.delta", item_id: commentary.id,
    output_index: 0, delta: commentary.content[0]!.text },
  { type: "response.output_item.added", output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: functionCall.id,
    output_index: 1, delta: checkpointArguments },
  { type: "response.function_call_arguments.done", item_id: functionCall.id,
    output_index: 1, arguments: checkpointArguments },
  { type: "response.output_item.done", output_index: 1, item: functionCall },
];

function completedResponse(output: readonly unknown[] = [commentary, functionCall]) {
  return { type: "response.completed", response: { status: "completed", output } };
}

function compactionThroughAdapter(events: readonly unknown[], suffix = "") {
  const fixture = semanticContractFixture({ policy: "execution-agent-v1" });
  const requests: ModelGatewayRequest[] = [];
  const acceptedTexts: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(sse(events, suffix), {
    headers: { "Content-Type": "text/event-stream" },
  }));
  fixture.invoke.mockImplementation(async (input) => {
    const requestBody = { ...input, modelPolicy: nativeRequest.modelPolicy };
    requests.push(requestBody);
    const result = await createOpenAIProviderAdapter().invoke({
      endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
    });
    if (result.kind !== "raw") throw new Error("Expected raw compaction output");
    const text = String(result.body.text);
    acceptedTexts.push(text);
    return { text, meta: {} };
  });
  const generateAndCommit = async () => {
    const candidate = await generateSemanticCompactionCandidate(fixture.params);
    fixture.store.commit(candidate);
    return candidate;
  };
  return { ...fixture, requests, acceptedTexts, fetchImpl, generateAndCommit };
}

beforeEach(() => vi.stubEnv("NATIVE_TEST_KEY", "fixture-only"));
afterEach(() => vi.unstubAllEnvs());

test("compaction keeps its input and real schema, then validates only terminal function arguments", async () => {
  const fixture = compactionThroughAdapter([...provisionalEvents, completedResponse()]);
  const candidate = await fixture.generateAndCommit();
  expect(fixture.invoke).toHaveBeenCalledOnce();
  expect(fixture.fetchImpl).toHaveBeenCalledOnce();
  const request = fixture.requests[0]!;
  const format = request.format as ModelGatewayJsonSchemaFormat;
  const realFormat = createSemanticCompactionFormat([fixture.source], 1024);
  expect(request.modelStep).toBe("context.compact");
  expect(format.schema.properties).toEqual(realFormat.schema.properties);
  expect(format.postValidatedSchemaConstraints).toEqual(realFormat.postValidatedSchemaConstraints);
  expect(format.postValidatedSchemaConstraints).toHaveLength(10);
  const messages = request.messages;
  if (!Array.isArray(messages)) throw new Error("Expected compaction message array");
  if (!messages.every(isTextChatMessage)) throw new Error("Expected compaction text messages");
  expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
  const payload = JSON.parse(String(fixture.fetchImpl.mock.calls[0]?.[1]?.body));
  expect(payload.input).toEqual(request.messages);
  expect(payload.tools).toEqual([{
    type: "function", name: format.name, strict: true, parameters: format.schema,
  }]);
  expect(payload.tool_choice).toEqual({ type: "function", name: format.name });
  expect(payload.parallel_tool_calls).toBe(false);
  expect(payload).not.toHaveProperty("text");
  expect(JSON.stringify(payload)).not.toContain("postValidatedSchemaConstraints");
  expect(fixture.acceptedTexts).toEqual([checkpointArguments]);
  expect(candidate.continuation).toEqual(continuation);
  expect(candidate.sourceDigests).toEqual([{
    sourceRef: fixture.source.sourceRef,
    sourceFingerprint: fixture.source.sourceFingerprint,
    digest: COMPACTION_FACT,
  }]);
  expect(fixture.store.get(fixture.params.scopeId)).toEqual(candidate);
});

test.each([
  ["EOF", undefined, "", "not completed"],
  ["DONE without completed", undefined, "data: [DONE]\n\n", "not completed"],
  ["incomplete", { type: "response.incomplete", response: {
    status: "incomplete", output: [functionCall], incomplete_details: { reason: "max_output_tokens" },
  } }, "", "incomplete"],
  ["provider error", { type: "error", error: { message: "fixture provider failure" } }, "", "fixture provider failure"],
  ["commentary alone", completedResponse([commentary]), "", "exactly one call"],
  ["wrong function", completedResponse([{ ...functionCall, name: "another_function" }]), "", "name mismatch"],
] as const)("%s cannot expose or commit a checkpoint", async (_name, terminal, suffix, message) => {
  const fixture = compactionThroughAdapter([
    ...provisionalEvents, ...(terminal ? [terminal] : []),
  ], suffix);
  await expect(fixture.generateAndCommit()).rejects.toThrow(message);
  expect(fixture.invoke).toHaveBeenCalledOnce();
  expect(fixture.acceptedTexts).toEqual([]);
  expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
});

test("a completed function still passes through runtime continuation post-validation", async () => {
  const invalidArguments = JSON.stringify({
    continuation: compactContinuation({ currentState: "x".repeat(SEMANTIC_COMPACTION_TEXT_MAX_LENGTH + 1) }),
    sourceDigests: { source_0: COMPACTION_FACT },
  });
  const fixture = compactionThroughAdapter([
    completedResponse([{ ...functionCall, arguments: invalidArguments }]),
  ]);
  await expect(fixture.generateAndCommit()).rejects.toMatchObject({
    message: "invalid_context_compaction_output",
    modelStep: "context.compact",
    validationStage: "semantic_compaction",
    issues: [expect.objectContaining({ code: "context_compaction_continuation_invalid" })],
  });
  expect(fixture.acceptedTexts.length).toBeGreaterThan(0);
  expect(fixture.acceptedTexts.every((text) => text === invalidArguments)).toBe(true);
  expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
});
