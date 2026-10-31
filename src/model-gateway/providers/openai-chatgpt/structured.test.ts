import { expect, test, vi } from "vitest";
import { createExecutionAgentDecisionFormat } from "../../../runtime/steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../../../runtime/steps/execution-agent/parser.js";
import { COMPACTION_FACT, compactContinuation, semanticContractFixture } from "../../../runtime/__tests__/support/semantic-compaction-contract-fixture.js";
import { generateSemanticCompactionCandidate } from "../../../runtime/context/semantic-compaction/run.js";
import { SEMANTIC_COMPACTION_TEXT_MAX_LENGTH } from "../../../runtime/context/semantic-compaction/contracts.js";
import type { ModelGatewayRequest } from "../../types.js";
import { isTextChatMessage } from "../../protocol/message-contract.js";
import { completedFunction, controlsFormat, functionArguments, preamble } from "../openai/__tests__/native-function-fixture.js";
import { invoke, request, response } from "./__tests__/fixture.js";
import { completedItemEvents } from "./__tests__/completed-items-fixture.js";

function terminal(name: string, argumentsText: string) {
  return { type: "response.completed", response: { status: "completed", output: [{
    type: "function_call", id: "fc_accepted", call_id: "accepted-1", status: "completed", name, arguments: argumentsText,
  }] } };
}

test("EA controls expose only terminal function arguments through the existing envelope", async () => {
  const requestBody = { ...request, modelStep: "capability.controls", format: controlsFormat };
  const result = await invoke(async () => response([...preamble, completedFunction]), requestBody);
  expect(result).toMatchObject({ kind: "raw", body: { text: functionArguments } });
  await expect(invoke(async () => response(preamble), requestBody)).rejects.toThrow("not completed");
  await expect(invoke(async () => response([terminal("wrong_name", functionArguments)]), requestBody)).rejects.toThrow("name mismatch");
  expect(await invoke(async () => response(completedItemEvents(functionArguments, controlsFormat.name)), requestBody))
    .toMatchObject({ kind: "raw", body: { text: functionArguments } });
});

test("EA decision with user interaction retains its real schema and runtime authority checks", async () => {
  const contract = { allowPlanner: true, allowUserInteraction: true };
  const format = createExecutionAgentDecisionFormat(contract);
  const decision = { action: "invoke_planner", objective: "Build the requested project.",
    interaction: { kind: "message", text: "אכין תוכנית ואמשיך." } };
  const text = ` {"decision":${JSON.stringify(decision)}} `;
  const fetchImpl = vi.fn<typeof fetch>(async () => response([terminal(format.name, text)]));
  const result = await invoke(fetchImpl, { ...request, agentMode: "fast", modelStep: "execution.decision", format });
  expect(result).toMatchObject({ kind: "raw", body: { text } });
  expect(parseExecutionAgentDecisionOutput(text, contract)).toEqual({ ok: true, decision });
  expect(parseExecutionAgentDecisionOutput(text, { ...contract, allowPlanner: false })).toMatchObject({ ok: false });
  const payload = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
  expect(payload.input.at(-1)).toEqual({ type: "additional_tools", role: "developer", tools: [{
    type: "function", name: format.name, strict: true, parameters: format.schema,
  }] });
});

function compaction(events: readonly unknown[]) {
  const fixture = semanticContractFixture({ policy: "execution-agent-v1" });
  const requests: ModelGatewayRequest[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async () => response(events));
  fixture.invoke.mockImplementation(async (input) => {
    const requestBody = { ...input, modelPolicy: request.modelPolicy };
    requests.push(requestBody);
    const result = await invoke(fetchImpl, requestBody);
    if (result.kind !== "raw") throw new Error("expected raw compaction");
    return { text: String(result.body.text), meta: {} };
  });
  const generateAndCommit = async () => {
    const candidate = await generateSemanticCompactionCandidate(fixture.params);
    fixture.store.commit(candidate);
    return candidate;
  };
  return { ...fixture, requests, fetchImpl, generateAndCommit };
}

test("compaction preserves source identities and canonical system history while projecting only its wire role", async () => {
  const continuation = compactContinuation();
  const fixture = compaction([terminal("context_compaction", JSON.stringify({
    continuation, sourceDigests: { source_0: COMPACTION_FACT },
  }))]);
  const candidate = await fixture.generateAndCommit();
  expect(candidate.continuation).toEqual(continuation);
  expect(candidate.sourceDigests).toEqual([{
    sourceRef: fixture.source.sourceRef, sourceFingerprint: fixture.source.sourceFingerprint, digest: COMPACTION_FACT,
  }]);
  expect(fixture.store.get(fixture.params.scopeId)).toEqual(candidate);
  const original = fixture.requests[0]!.messages!;
  if (!Array.isArray(original) || !original.every(isTextChatMessage)) throw new Error("expected canonical compaction messages");
  const payload = JSON.parse(String(fixture.fetchImpl.mock.calls[0]![1]!.body));
  expect(original[0]).toMatchObject({ role: "system" });
  expect(payload.input.slice(0, -1)).toEqual(original.map((message) =>
    message.role === "system" ? { ...message, role: "developer" } : message));
  expect(payload.input.at(-1).tools[0].name).toBe("context_compaction");
  expect(JSON.stringify(payload)).not.toContain("postValidatedSchemaConstraints");
});

test.each([
  { events: [] },
  { events: [{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }] },
])("an unfinished response cannot commit a compaction checkpoint", async ({ events }) => {
  const fixture = compaction(events);
  await expect(fixture.generateAndCommit()).rejects.toThrow();
  expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
  expect(fixture.fetchImpl).toHaveBeenCalledOnce();
});

test("assembled compaction items retain runtime validation before committing the checkpoint", async () => {
  const continuation = compactContinuation();
  const fixture = compaction(completedItemEvents(JSON.stringify({
    continuation, sourceDigests: { source_0: COMPACTION_FACT },
  }), "context_compaction"));
  const candidate = await fixture.generateAndCommit();
  expect(candidate.continuation).toEqual(continuation);
  expect(fixture.store.get(fixture.params.scopeId)).toEqual(candidate);
  const invalid = compaction(completedItemEvents(JSON.stringify({
    continuation: compactContinuation({ currentState: "x".repeat(SEMANTIC_COMPACTION_TEXT_MAX_LENGTH + 1) }),
    sourceDigests: { source_0: COMPACTION_FACT },
  }), "context_compaction"));
  await expect(invalid.generateAndCommit()).rejects.toMatchObject({ message: "invalid_context_compaction_output" });
  expect(invalid.store.get(invalid.params.scopeId)).toBeUndefined();
});
