import { afterEach, expect, test, vi } from "vitest";
import { createExecutionAgentDecisionFormat } from "../../../runtime/steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../../../runtime/steps/execution-agent/parser.js";
import type { ModelGatewayEvent } from "../../types.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createOpenAIProviderAdapter } from "../openai/adapter.js";
import { OpenAIResponsesStreamNormalizer } from "../openai/stream-normalizer.js";
import { invoke, request, response } from "./__tests__/fixture.js";
import { completedItemEvents, observedArguments, observedDecision, observedResponseId } from "./__tests__/completed-items-fixture.js";

const contract = { allowPlanner: false, allowUserInteraction: true, includeTitle: true, directResponseMaxLength: 1024 };
const format = createExecutionAgentDecisionFormat(contract);
const requestBody = { ...request, modelStep: "execution.decision", format };
const eventOf = (events: Record<string, unknown>[], type: string) => events.find((event) => event.type === type)!;
const itemOf = (event: Record<string, unknown>) => event.item as Record<string, unknown>;
const terminalOf = (events: Record<string, unknown>[]) => events.at(-1)!.response as Record<string, unknown>;
afterEach(() => vi.unstubAllEnvs());

test.each(["raw", "chat"] as const)("%s accepts the observed SIWC finalized-item/empty-snapshot stream only at completed", async (endpoint) => {
  const wire = completedItemEvents();
  const normalizer = new OpenAIResponsesStreamNormalizer({
    functionOutputName: format.name, requireCompletedResponse: true, assembleCompletedFunctionItems: true,
  });
  for (const event of wire.slice(0, -1)) expect(normalizer.consume(event)).toEqual([]);
  expect(normalizer.consume(wire.at(-1))).toMatchObject([
    { type: "content", text: observedArguments }, { type: "done", done: true },
  ]);
  const result = await invoke(async () => response(wire), requestBody, endpoint);
  let text = "";
  if (result.kind === "raw") text = String(result.body.text);
  else if (result.kind === "chat") {
    const events: ModelGatewayEvent[] = [];
    await result.stream({ emit: (event) => events.push(event) });
    expect(events).toMatchObject([{ type: "content", text: observedArguments }, { type: "done", done: true }]);
    text = events.flatMap((event) => event.type === "content" ? [event.text] : []).join("");
  } else throw new Error("expected inference");
  expect(text).toBe(observedArguments);
  expect(parseExecutionAgentDecisionOutput(text, contract)).toEqual({ ok: true, decision: observedDecision });
});

const conflicts: ReadonlyArray<{ name: string; change(events: Record<string, unknown>[]): void }> = [
  { name: "different terminal response", change(events) { terminalOf(events).id = "other"; } },
  { name: "different in-progress response", change(events) { (events[1]!.response as Record<string, unknown>).id = "other"; } },
  { name: "wrong optional event response", change(events) { events[2]!.response_id = "other"; } },
  { name: "different final item id", change(events) { itemOf(eventOf(events, "response.output_item.done")).id = "other"; } },
  { name: "different final call id", change(events) { itemOf(eventOf(events, "response.output_item.done")).call_id = "other"; } },
  { name: "different final index", change(events) { eventOf(events, "response.output_item.done").output_index = 1; } },
  { name: "different final name", change(events) { itemOf(eventOf(events, "response.output_item.done")).name = "other"; } },
  { name: "different argument item", change(events) { eventOf(events, "response.function_call_arguments.done").item_id = "other"; } },
  { name: "contradictory final arguments", change(events) { itemOf(eventOf(events, "response.output_item.done")).arguments = "{}"; } },
  { name: "unfinished final item", change(events) { itemOf(eventOf(events, "response.output_item.done")).status = "in_progress"; } },
  { name: "second distinct function", change(events) {
    const first = eventOf(events, "response.output_item.added");
    events.splice(3, 0, { ...first, output_index: 1, item: { ...itemOf(first), id: "fc_2", call_id: "call_2" } });
  } },
];

test.each(conflicts)("rejects $name without accepting assembled arguments", async ({ change }) => {
  const events = completedItemEvents();
  change(events);
  await expect(invoke(async () => response(events), requestBody)).rejects.toThrow(/identity mismatch|items conflict/u);
});

test.each([
  { type: "response.output_item.added", position: 2 },
  { type: "response.output_item.done", position: 2 },
  { type: "response.output_item.added", position: -1 },
  { type: "response.output_item.done", position: -1 },
])("$type at position $position cannot reuse a function index", async ({ type, position }) => {
  const events = completedItemEvents();
  events.splice(position, 0, { type, output_index: 0, item: { type: "reasoning", id: "reasoning_item" } });
  await expect(invoke(async () => response(events), requestBody)).rejects.toThrow("items conflict");
});

test.each([2, -1])("non-function items at distinct indexes remain valid at position %i", async (position) => {
  const events = completedItemEvents();
  const item = { type: "reasoning", id: "reasoning_item" };
  events.splice(position, 0,
    { type: "response.output_item.added", output_index: 1, item },
    { type: "response.output_item.done", output_index: 1, item });
  expect(await invoke(async () => response(events), requestBody))
    .toMatchObject({ kind: "raw", body: { text: observedArguments } });
});

test.each([
  { name: "EOF", ending: undefined },
  { name: "DONE", ending: "data: [DONE]\n\n" },
  { name: "failed", ending: { type: "response.failed", response: { error: { message: "usage denied" } } } },
  { name: "incomplete", ending: { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } } },
])("$name never authorizes a finalized item", async ({ ending }) => {
  const events = completedItemEvents().slice(0, -1);
  if (ending && typeof ending !== "string") events.push(ending);
  await expect(invoke(async () => response(events, typeof ending === "string" ? ending : ""), requestBody)).rejects.toThrow();
});

test("refusal, missing final item and invalid argument JSON remain failures", async () => {
  const refused = completedItemEvents();
  refused.splice(-1, 0, { type: "response.output_item.done", output_index: 1,
    item: { type: "message", id: "refusal", content: [{ type: "refusal", refusal: "denied" }] } });
  await expect(invoke(async () => response(refused), requestBody)).rejects.toThrow("refused");
  const unfinished = completedItemEvents().filter((event) => event.type !== "response.output_item.done");
  await expect(invoke(async () => response(unfinished), requestBody)).rejects.toThrow("item not completed");
  await expect(invoke(async () => response(completedItemEvents("not JSON")), requestBody)).rejects.toThrow("arguments");
  await expect(invoke(async () => response(completedItemEvents(observedArguments, "wrong_name")), requestBody)).rejects.toThrow("name mismatch");
});

test("only explicit empty completed snapshots are assembled, and nonempty snapshots keep authority", async () => {
  const missing = completedItemEvents();
  delete terminalOf(missing).output;
  await expect(invoke(async () => response(missing), requestBody)).rejects.toThrow("not completed");
  const nonempty = completedItemEvents();
  terminalOf(nonempty).output = [{ ...itemOf(eventOf(nonempty, "response.output_item.done")), arguments: "{}" }];
  expect(await invoke(async () => response(nonempty), requestBody)).toMatchObject({ kind: "raw", body: { text: "{}" } });
  const malformed = completedItemEvents();
  terminalOf(malformed).status = "in_progress";
  await expect(invoke(async () => response(malformed), requestBody)).rejects.toThrow("not completed");
});

test("matching optional response IDs and identical receipts remain one call", async () => {
  const events = completedItemEvents();
  for (const event of events) event.response_id = observedResponseId;
  events.splice(3, 0, structuredClone(eventOf(events, "response.output_item.added")));
  events.splice(-2, 0, structuredClone(eventOf(events, "response.function_call_arguments.done")));
  events.splice(-1, 0, structuredClone(eventOf(events, "response.output_item.done")));
  expect(await invoke(async () => response(events), requestBody)).toMatchObject({ kind: "raw", body: { text: observedArguments } });
});

test("API-key adapter still requires the authoritative terminal function snapshot", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-only");
  const apiRequest = { ...requestBody, modelPolicy: { ...request.modelPolicy!, providers: { plan: { type: "openai" } } } };
  await expect(createOpenAIProviderAdapter().invoke({
    endpoint: "raw", requestBody: apiRequest, invocation: resolveModelInvocation(apiRequest),
    fetchImpl: async () => response(completedItemEvents()),
  })).rejects.toThrow("requires exactly one call");
});
