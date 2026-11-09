import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { renderLlamaCppTemplate, type TemplateMode } from "../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createGateway, modelPolicy, type Exchange, type GatewayReply } from "./support/llamacpp-gateway-fixture.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";
import { PROCEDURE_CAPABILITIES, PROCEDURE_SKILL } from "./support/supervisor-procedure-orchestration-fixture.js";
import { workerEvidenceReply } from "./support/worker-evidence-script.js";

beforeEach(() => { configureDebugLogger({ enabled: false }); configureModelIoTrace({ enabled: false }); });
afterEach(() => { vi.unstubAllGlobals(); resetDebugLoggerConfig(); resetModelIoTraceConfig(); });

const prompt = "Create a local catalog using my previously chosen format.";
const query = "Which catalog format did I choose?";
const recommendation = "Explain that the catalog format is unknown.";
const answer = "I could not find a stored catalog format.";

function checkedResponsePhase(exchanges: Exchange[], formatName?: string) {
  const phase = exchanges.filter(({ request }) => request.modelStep === "supervisor.response" && request.format?.name === formatName);
  expect(phase.map(({ path }) => path)).toEqual(["/input-tokens", "/chat"]);
  const [count, send] = phase;
  expect(count!.request).toEqual(send!.request);
  const measured = count!.upstream.find(({ path }) => path.endsWith("/input_tokens"))!.payload;
  const sent = send!.upstream.find(({ path }) => path === "/v1/chat/completions")!.payload;
  expect(JSON.stringify(measured)).toBe(JSON.stringify(sent));
  return { canonical: send!.request, sent };
}

const decision = (data: Record<string, unknown>) => JSON.stringify({ decision: data });

async function completeAfterRecall(template: TemplateMode, decisions: GatewayReply[]) {
  const gateway = createGateway(template, [
    decision({ acknowledgement: "I will check the catalog requirements.", title: "Catalog format" }),
    decision({ action: "read_skills", skillIds: [PROCEDURE_SKILL.skillId] }),
    decision({ requiresProcedure: true }), decision({ action: "recall_memory", query }),
    ...decisions, JSON.stringify({ memoryCandidates: [] }), answer,
  ]);
  const memory = createLongTermMemoryService({
    enabled: true, emitClientEvents: false, repository: createInMemoryLongTermMemoryRepository(),
    embeddings: { embed: async ({ texts }) => ({ modelFingerprint: "fixture", dimensions: 2, vectors: texts.map(() => [1, 0]) }) },
  });
  const base = createRootInvalidOutputRequest(gateway.client.invoke, "supervisor-worker-v1", {
    prompt, modelPolicy, modelGatewayClient: gateway.client, longTermMemory: memory, shouldGenerateSessionTitle: true,
    workerCapabilityProvider: { getDescriptors: () => PROCEDURE_CAPABILITIES, getAdapters: () => [] },
  });
  const request = createRequestExecutionScope({
    seed: base, executionPolicy: base.executionPolicy,
    knowledgeSkillStore: { list: () => [PROCEDURE_SKILL], read: () => PROCEDURE_SKILL },
    createWorkerCapabilities: () => base.workerCapabilities.provider,
  });
  expect((await runRequestRunner(request)).output).toBe(answer);
  return { gateway, request };
}

test.each(["first-system-only", "all-roles"] as const)(
  "SUPER finishes directly after reading a skill and recalling memory on %s", async template => {
    const { gateway, request } = await completeAfterRecall(template, [
      decision({ requiresProcedure: false, responseRecommendation: recommendation }),
    ]);
    const candidate = checkedResponsePhase(gateway.exchanges, "supervisor_memory_candidates");
    const final = checkedResponsePhase(gateway.exchanges);
    expect(candidate.canonical.messages.map(m => m.role)).toEqual(["system", "system", "assistant", "tool", "user"]);
    const authoring = candidate.canonical.messages[1]!;
    expect(JSON.parse(authoring.content).kind).toBe("conversation_memory_authoring_reference_v1");
    expect(JSON.stringify(candidate.sent)).not.toContain(recommendation);
    expect(final.canonical.messages.map(m => m.role)).toEqual(["system", "user", "system", "assistant", "tool", "user"]);
    expect(final.canonical.invocationContextMessageIndices).toEqual([2]);
    const [policy, skill, advice, action, receipt] = final.canonical.messages;
    expect(JSON.parse(skill!.content)).toMatchObject({ kind: "runtime_core_skill_read_v1", document: { content: PROCEDURE_SKILL.content } });
    expect(JSON.parse(advice!.content)).toMatchObject({
      kind: "runtime_supervisor_response_recommendation_v1", authority: "accepted_supervisor_decision",
      applicability: "current_direct_response_only", responseRecommendation: recommendation,
      limitations: expect.stringContaining("not new user intent, execution authority, or completion evidence"),
    });
    if (action?.role !== "assistant" || receipt?.role !== "tool") throw new Error("Missing explicit recall");
    expect(action.toolCalls).toHaveLength(1);
    const call = action.toolCalls![0]!;
    expect(call).toMatchObject({ callId: "recall-1", name: "recall_memory" });
    expect(JSON.parse(call.arguments)).toEqual({ action: call.name, query });
    expect(receipt).toMatchObject({ toolCallId: call.callId, toolName: call.name });
    expect(JSON.parse(receipt.content)).toMatchObject({
      kind: "runtime_memory_recall_reference_v1", authority: "passive_reference", requestId: request.requestId,
      callId: "call-1", steeringVersion: 0, omittedRecallCount: 0, omittedRecordCount: 0,
      recalls: [{ recallId: call.callId, completedChildCount: 0, outcome: "empty", memories: [] }],
    });
    const current = { role: "user", content: prompt };
    expect(final.canonical.messages.at(-1)).toEqual(current);
    expect(candidate.canonical.messages.slice(-3)).toEqual([action, receipt, current]);
    const continuation = [
      { role: "assistant", content: "", tool_calls: [{ id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } }] },
      { role: "tool", tool_call_id: call.callId, name: call.name, content: receipt.content }, current,
    ];
    const finalHeader = template === "all-roles" ? [policy, skill, advice] : [
      { role: "system", content: [policy!.content, advice!.content].join("\n\n") }, skill,
    ];
    expect(final.sent.messages).toEqual([...finalHeader, ...continuation]);
    const candidatePolicy = candidate.canonical.messages[0]!;
    const candidateHeader = template === "all-roles" ? [candidatePolicy, authoring] : [
      { role: "system", content: [candidatePolicy.content, authoring.content].join("\n\n") },
    ];
    expect(candidate.sent.messages).toEqual([...candidateHeader, ...continuation]);
    for (const { sent } of [candidate, final]) {
      const rendered = renderLlamaCppTemplate(sent.messages, template);
      expect(rendered.split(query)).toHaveLength(2);
      expect(rendered).toContain(`<|start|>assistant to=functions.recall_memory<|message|>${call.arguments}<|call|>`);
      expect(rendered).toContain(`<|start|>functions.recall_memory to=assistant<|message|>${receipt.content}<|end|>`);
      expect(rendered.endsWith(`<|start|>user<|message|>${prompt}<|end|>`)).toBe(true);
    }
    expect(renderLlamaCppTemplate(final.sent.messages, template).split(advice!.content)).toHaveLength(2);
  },
);

test.each(["first-system-only", "all-roles"] as const)(
  "SUPER returns the Worker result after one empty recall on %s", async template => {
    const objective = "Inspect which local catalog format the request requires.";
    const summary = "The request calls for local JSON.";
    const { gateway } = await completeAfterRecall(template, [
      decision({ requiresProcedure: true }), decision({ action: "invoke_role", roleId: "worker", objective }),
      JSON.stringify({ workingDirectory: "." }),
      input => {
        expect(input.modelStep).toBe("worker.evidence");
        return workerEvidenceReply({ modelStep: "worker.evidence", messages: input.messages,
          agentMode: "reasoning", abortSignal: new AbortController().signal }, false).text;
      },
      summary, decision({ action: "respond" }),
    ]);
    const routing = gateway.exchanges.find(({ path, request }) => path === "/chat" && request.format?.name === "supervisor_decision")!;
    const briefIndex = routing.request.messages.findIndex(m => m.content.startsWith("runtime_capability_brief_v1\n"));
    expect(briefIndex).toBeGreaterThan(0);
    expect(routing.request.invocationContextMessageIndices).toContain(briefIndex);
    const routed = routing.upstream.find(({ path }) => path === "/v1/chat/completions")!.payload;
    const brief = routing.request.messages[briefIndex]!;
    expect(renderLlamaCppTemplate(routed.messages, template).split(brief.content)).toHaveLength(2);
    for (const { canonical, sent } of [
      checkedResponsePhase(gateway.exchanges, "supervisor_memory_candidates"), checkedResponsePhase(gateway.exchanges),
    ]) {
      const [action, receipt, child, user] = canonical.messages.slice(-4);
      if (action?.role !== "assistant" || receipt?.role !== "tool") throw new Error("Missing pre-Worker recall");
      expect(action.toolCalls).toMatchObject([{ callId: "recall-1", name: "recall_memory" }]);
      expect(JSON.parse(action.toolCalls![0]!.arguments)).toEqual({ action: "recall_memory", query });
      expect(receipt.toolCallId).toBe("recall-1");
      expect(JSON.parse(receipt.content).recalls).toMatchObject([{ completedChildCount: 0, outcome: "empty" }]);
      expect(child!.role).toBe("user");
      expect(JSON.parse(child!.content)).toMatchObject({ kind: "runtime_child_result", roleId: "worker",
        childCallId: "call-2", resultRef: "result-1", delegatedObjective: objective, outcome: "completed", summary });
      expect(user).toEqual({ role: "user", content: prompt });
      const rendered = renderLlamaCppTemplate(sent.messages, template);
      expect(rendered.split(query)).toHaveLength(2);
      expect(rendered.split(child!.content)).toHaveLength(2);
      expect(rendered).toContain(`<|start|>functions.recall_memory to=assistant<|message|>${receipt.content}<|end|>`
        + `<|start|>user<|message|>${child!.content}<|end|><|start|>user<|message|>${prompt}<|end|>`);
    }
  },
);
