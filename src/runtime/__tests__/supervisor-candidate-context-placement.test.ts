import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { projectChatGatewayMessages } from "../../model-gateway/client/message-projection.js";
import { resolveModelInvocation } from "../../model-gateway/policy/invocation-policy.js";
import { renderLlamaCppTemplate } from "../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import { countLlamaCppInputTokens } from "../../model-gateway/providers/llamacpp/input-token-count.js";
import type { ChatMessage, ModelGatewayRequest } from "../../model-gateway/types.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { buildSupervisorMemoryAuthoringInput } from "../steps/supervisor-response/input.js";
import { runSupervisorAuthoredResponse } from "../steps/supervisor-response/run.js";
import { createMemoryRecallHarness, MEMORY_RECORD, modelMessages } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

async function countOnFirstSystemTemplate(messages: readonly ChatMessage[], format: unknown) {
  const requestBody: ModelGatewayRequest = {
    ...projectChatGatewayMessages({ messages }), format, modelStep: "supervisor.response",
    modelPolicy: {
      providers: { local: { type: "llamacpp", baseUrl: "http://fixture" } },
      profiles: { local: { provider: "local", model: "local", contextWindowTokens: 32768 } },
      defaults: { profileId: "local" },
    },
  };
  let counted: { role: string; content: string }[] | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/apply-template")) return Response.json({ prompt: renderLlamaCppTemplate(body.messages, "first-system-only") });
    expect(String(url)).toBe("http://fixture/v1/chat/completions/input_tokens");
    counted = body.messages;
    return Response.json({ input_tokens: 43 });
  };
  const result = await countLlamaCppInputTokens({ endpoint: "chat", invocation: resolveModelInvocation(requestBody), requestBody, fetchImpl });
  return { result, counted, indices: requestBody.invocationContextMessageIndices };
}

test("only the bound SUPER candidate snapshot may precede settled history on the first-system template", async () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => { throw Error("Unexpected decision"); } });
  const memory = createLongTermMemoryService({
    enabled: true, emitClientEvents: false,
    repository: createInMemoryLongTermMemoryRepository({ schemaVersion: 5, revision: 1, records: [MEMORY_RECORD], vectors: [] }),
    embeddings: { embed: async ({ texts }) => ({ modelFingerprint: "fixture", dimensions: 2, vectors: texts.map(() => [1, 0]) }) },
  });
  const prepare = vi.fn(memory.learning!.prepare);
  const history = [
    { id: "past-user", role: "user" as const, content: "Past user turn.", createdAt: "2026-11-05T12:00:00.000Z" },
    { id: "past-assistant", role: "assistant" as const, content: "Past assistant turn.", createdAt: "2026-11-05T12:00:01.000Z" },
  ];
  const request = deriveTestRequestExecutionScope(f.request, {
    historyMessages: history, longTermMemory: { ...f.memory, learning: { ...memory.learning!, prepare } },
  });
  const update = "Keep the answer brief.";
  f.requestSteering.append({ steerId: "current-update", text: update });
  f.invoke.mockImplementation(async (input) => ({
    text: input.format ? JSON.stringify({ memoryCandidates: [{
      content: "Prefers brief answers.", tags: [], target: null, score: 80, reason: "Current steering.",
      reinforced: false, explicitRequestQuote: null,
    }] }) : "Final answer.", meta: {},
  }));
  const options = {
    call: { rootCallId: "root", callId: "root", parentCallId: null, depth: 0, invocationAttempt: 1 },
    toolResults: { sourceRevision: 3, results: [{ executionId: "settled", callId: "root", invocationAttempt: 1,
      capabilityId: "fixture.observe", outcome: "succeeded", declaredEffect: "observation", observedEffect: "observation",
      summary: "A settled observation." }] },
    steeringSnapshot: f.requestSteering.snapshot(),
  } as const;
  const authored = await runSupervisorAuthoredResponse(request, options);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  const candidateInput = f.invoke.mock.calls[0]![0];
  expect(candidateInput.format).toMatchObject({ name: "supervisor_memory_candidates" });
  const candidate = modelMessages(candidateInput);
  const final = modelMessages(f.invoke.mock.calls[1]![0]);
  const snapshot = candidate.find((m) => m.content.startsWith('{"kind":"conversation_memory_authoring_reference_v1"'))!;
  const position = candidate.indexOf(snapshot);
  expect(candidate.slice(position - 2, position).map((m) => m.content)).toEqual(history.map((m) => m.content));
  expect(JSON.parse(candidate[position + 1]!.content).results[0].executionId).toBe("settled");
  expect(final.some((m) => m.content === snapshot.content)).toBe(false);
  expect(authored.memoryCandidates[0]?.assessment?.evidence).toMatchObject({
    sourceRequestId: request.requestId, sourceSessionId: request.sessionId,
    evidenceDigest: createHash("sha256").update(JSON.stringify([request.prompt, update])).digest("hex"),
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(f.memory.retrieve).not.toHaveBeenCalled();
  const original = await countOnFirstSystemTemplate(candidate, candidateInput.format);
  expect(original.result).toMatchObject({ kind: "counted", inputTokens: 43 });
  expect(original.indices).toEqual([position]);
  expect(original.counted).toEqual([
    { role: "system", content: [candidate[0]!.content, snapshot.content].join("\n\n") },
    ...candidate.slice(1).filter((m) => m !== snapshot),
  ]);
  const supplied = buildSupervisorMemoryAuthoringInput(request, { ...options, memoryAuthoringMessage: { ...snapshot } });
  const forged = await countOnFirstSystemTemplate(supplied.context.messages, candidateInput.format);
  expect(forged.indices).toBeUndefined();
  expect(forged.result).toMatchObject({ kind: "error", statusCode: 400 });
  expect(forged.counted).toBeUndefined();
});
