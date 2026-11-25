import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { renderLlamaCppTemplate, type TemplateMode } from "../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { CONVERSATION_MEMORY_PLAIN_TEXT_HEADER } from "../long-term-memory/conversation-authoring/plain-text-context.js";
import { projectMemoryRecallContinuations } from "../long-term-memory/recall-continuation.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createSupervisorArtifactPathsReadmissionController } from "../steps/supervisor-decision/artifact-paths.js";
import { buildSupervisorResponseInput } from "../steps/supervisor-response/input.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { createRequestUserInteractions } from "../user-interactions/request-service.js";
import { evidenceDescriptor } from "./support/execution-controls-evidence-fixture.js";
import { MEMORY_RECORD } from "./support/memory-recall-runner.js";
import { settleRootRecall } from "./support/root-compaction-evidence.js";
import { createRootInvalidOutputLedger, createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";
import { createProcedureOrchestrationFixture, PROCEDURE_CAPABILITIES, PROCEDURE_SKILL } from "./support/supervisor-procedure-orchestration-fixture.js";
import { createGateway, modelPolicy, type Exchange } from "./support/llamacpp-gateway-fixture.js";

const time = { currentDateTime: "2026-11-05 09:00:00 GMT", timeZone: "UTC" };

/** Assert both transports and the role frames consumed by the renderer, separately from the producer. */
function expectPackedMessages(exchanges: Exchange[], exchange: Exchange, indices: number[], template: TemplateMode) {
  const { messages, invocationContextMessageIndices } = exchange.request;
  expect(invocationContextMessageIndices).toEqual(indices);
  const count = exchanges.filter(({ path, request }) => path === "/input-tokens" && isDeepStrictEqual(request.messages, messages)).at(-1)!;
  expect(count.request.invocationContextMessageIndices).toEqual(indices);
  const counted = count.upstream.find(({ path }) => path.endsWith("/input_tokens"))!.payload;
  const sent = exchange.upstream.find(({ path }) => path === "/v1/chat/completions")!.payload;
  expect(sent).toEqual(counted);
  expect(sent).not.toHaveProperty("invocationContextMessageIndices");
  const header = [messages[0]!, ...indices.map(i => messages[i]!)].map(m => m.content).join("\n\n");
  const expected = template === "all-roles" ? messages : [
    { role: "system", content: header }, ...messages.slice(1).filter((_, i) => !indices.includes(i + 1)),
  ];
  expect(sent.messages).toEqual(expected);
  const prompt = renderLlamaCppTemplate(sent.messages, template);
  const frames = [...prompt.matchAll(/<\|start\|>([^<]+)<\|message\|>([\s\S]*?)<\|end\|>/g)];
  expect(frames.map(([, role, content]) => ({ role, content }))).toEqual(
    expected.map(m => ({ role: m.role === "system" ? "developer" : m.role, content: m.content })),
  );
}

beforeEach(() => { configureDebugLogger({ enabled: false }); configureModelIoTrace({ enabled: false }); });
afterEach(() => { vi.unstubAllGlobals(); resetDebugLoggerConfig(); resetModelIoTraceConfig(); });

test.each(["first-system-only", "all-roles"] as const)(
  "EA continues after publishing progress with both passive memory references on %s", async (template) => {
    const progress = "I will inspect the selected target.";
    const answer = "The target is ready for inspection.";
    const gateway = createGateway(template, [
      JSON.stringify({ decision: { action: "open_capability_scope", catalogGroupIds: ["evidence"],
        interaction: { kind: "message", text: progress } } }),
      JSON.stringify({ decision: { action: "respond", response: answer, memoryCandidates: [] } }),
    ]);
    const repository = createInMemoryLongTermMemoryRepository({
      schemaVersion: 5, revision: 1, records: [MEMORY_RECORD], vectors: [],
    });
    const memory = createLongTermMemoryService({ enabled: true, repository, emitClientEvents: false,
      embeddings: { embed: async ({ texts }) => ({ modelFingerprint: "fixture", dimensions: 2, vectors: texts.map(() => [1, 0]) }) },
    });
    const event = vi.fn();
    const base = createRootInvalidOutputRequest(gateway.client.invoke, "execution-agent-v1", {
      modelPolicy, modelGatewayClient: gateway.client, longTermMemory: memory, temporalContext: time,
      userInteractions: createRequestUserInteractions({ requestId: "root-invalid-request", events: { event } }),
      workerCapabilityProvider: { getDescriptors: () => [evidenceDescriptor], getAdapters: () => [] },
    });
    const request = createRequestExecutionScope({ seed: base, executionPolicy: base.executionPolicy,
      requestWorkingDirectory: resolve("test-agent-work"), createWorkerCapabilities: () => base.workerCapabilities.provider });
    expect((await runRequestRunner(request)).output).toBe(answer);
    expect(event).toHaveBeenCalledTimes(1);
    const turns = gateway.exchanges.filter(({ path }) => path === "/chat");
    expect(turns).toHaveLength(2);
    const second = turns[1]!;
    const messages = second.request.messages;
    expect(messages.map(m => m.role)).toEqual(["system", "user", "system", "system", "system", "system", "user", "user", "user", "user"]);
    expect(JSON.parse(messages[1]!.content)).toMatchObject({
      kind: "runtime_user_interaction_receipts_v1", authority: "assistant_communication", entries: [{ text: progress }],
    });
    expect(JSON.parse(messages[2]!.content)).toMatchObject({ kind: "runtime_filesystem_scope_v1", agentWorkRoot: resolve("test-agent-work") });
    expect(JSON.parse(messages[3]!.content)).toMatchObject({
      kind: "runtime_long_term_memory_reference_v1", authority: "passive_reference", memories: [{ content: MEMORY_RECORD.content }],
    });
    expect(messages[4]!.content.startsWith(CONVERSATION_MEMORY_PLAIN_TEXT_HEADER)).toBe(true);
    expect(JSON.parse(messages[5]!.content)).toMatchObject({ kind: "runtime_request_time_v1", ...time });
    expect(messages.at(-1)!.content).toBe(request.prompt);
    expectPackedMessages(gateway.exchanges, second, [2, 3, 4, 5], template);
  },
);

test.each(["first-system-only", "all-roles"] as const)(
  "EA presents five settled receipts and an empty memory authoring reference on %s", async (template) => {
    const answer = "Four changes succeeded and one failed.";
    const targets = ["first", "second", "rejected", "fourth", "fifth"];
    const decision = (value: Record<string, unknown>) => JSON.stringify({ decision: value });
    const gateway = createGateway(template, [
      decision({ action: "open_capability_scope", catalogGroupIds: ["files"], interaction: { kind: "message", text: "Starting work." } }),
      ...targets.map((target, index) => decision({ action: "invoke_capability", capabilityId: "fixture.write",
        selectionControls: { target }, ...(index === 0 ? { workingDirectory: "." } : {}) })),
      decision({ action: "respond" }), JSON.stringify({ finalResponse: answer, memoryCandidates: [] }),
    ]);
    const descriptor = {
      capabilityId: "fixture.write", summary: "Modify the selected fixture target.", effect: "mutation", catalogGroups: ["files"],
      controls: { type: "object", additionalProperties: false, properties: { target: { type: "string", minLength: 1, maxLength: 256 } }, required: ["target"] },
      selectionControlIds: ["target"], controlsRefinement: "mechanical_when_complete",
    } as const;
    const executed: string[] = [];
    const adapter = { descriptor, async execute({ controls }: { controls: Record<string, unknown> }) {
      const target = String(controls.target);
      executed.push(target);
      if (target === "rejected") return { outcome: "failed", observedEffect: "none", summary: "Rejected.", failureOutcomeFingerprint: null } as const;
      return { outcome: "succeeded", observedEffect: "mutation", summary: "Saved.", references: [{ kind: "tool_target", target }] } as const;
    } };
    const memory = createLongTermMemoryService({ enabled: true, emitClientEvents: false, repository: createInMemoryLongTermMemoryRepository(),
      embeddings: { embed: async ({ texts }) => ({ modelFingerprint: "fixture", dimensions: 2, vectors: texts.map(() => [1, 0]) }) },
    });
    const request = createRootInvalidOutputRequest(gateway.client.invoke, "execution-agent-v1", {
      modelPolicy, modelGatewayClient: gateway.client, longTermMemory: memory, temporalContext: time,
      userInteractions: createRequestUserInteractions({ requestId: "root-invalid-request", events: { event: vi.fn() } }),
      workerCapabilityProvider: { getDescriptors: () => [descriptor], getAdapters: () => [adapter] },
    });
    expect((await runRequestRunner(request)).output).toBe(answer);
    expect(executed).toEqual(targets);

    const [count, chat] = gateway.exchanges.filter(e => e.request.modelStep === "execution.response");
    expect([count?.path, chat?.path]).toEqual(["/input-tokens", "/chat"]);
    const source = chat!.request.messages;
    const header = source.slice(0, 6);
    expect(header.map(m => m.role)).toEqual(["system", "user", "user", "user", "system", "user"]);
    expect(JSON.parse(header[4]!.content)).toMatchObject({ kind: "conversation_memory_authoring_reference_v1", entries: [], omitted: 0 });
    expect(header[5]!.content).toBe(request.prompt);
    expect(source).toHaveLength(16);
    expect(chat!.request.invocationContextMessageIndices).toEqual([4]);
    expect(count!.request.messages).toEqual(source);
    expect(count!.request.invocationContextMessageIndices).toEqual([4]);

    const expectedHeader = template === "all-roles" ? header : [
      { role: "system", content: [header[0]!.content, header[4]!.content].join("\n\n") },
      ...header.filter(m => m.role === "user"),
    ];
    const expectedPairs = targets.flatMap((target, i) => {
      const action = source[6 + 2 * i], receipt = source[7 + 2 * i];
      if (!action?.toolCalls || receipt?.role !== "tool") throw new Error("Missing canonical action or receipt.");
      expect(action.toolCalls).toHaveLength(1);
      const call = action.toolCalls[0]!;
      const id = `capability-execution-${i + 1}`;
      expect(call.callId).toBe(id);
      expect(receipt.toolCallId).toBe(id);
      expect(receipt.toolName).toBe(call.name);
      expect(JSON.parse(call.arguments).invocation).toMatchObject({ executionId: id, controls: { target } });
      expect(JSON.parse(receipt.content).result).toMatchObject({ executionId: id, outcome: i === 2 ? "failed" : "succeeded" });
      return [
        { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
        { role: "tool", name: call.name, tool_call_id: id, content: receipt.content },
      ];
    });
    const sent = chat!.upstream.find(u => u.path === "/v1/chat/completions")!.payload;
    const counted = count!.upstream.find(u => u.path === "/v1/chat/completions/input_tokens")!.payload;
    expect(JSON.stringify(sent)).toBe(JSON.stringify(counted));
    expect(sent.messages).toEqual([...expectedHeader, ...expectedPairs]);
    const prompt = renderLlamaCppTemplate(sent.messages, template);
    const userFrames = [...prompt.matchAll(/<\|start\|>user<\|message\|>([\s\S]*?)<\|end\|>/g)].map(([, content]) => content);
    expect(userFrames).toEqual(source.filter(m => m.role === "user").map(m => m.content));
  },
);

function supervisorInput() {
  const { request } = createProcedureOrchestrationFixture(() => ({ action: "respond" }));
  return buildSupervisorDelegationInput({ ...request, modelPolicy, temporalContext: time }, {
    toolResults: { results: [], sourceRevision: 0 },
  });
}

test.each(["first-system-only", "all-roles"] as const)("SUPER keeps its completed turn and time reference on %s", async template => {
  const gateway = createGateway(template, ["ok"]);
  const { context, format, modelStep } = supervisorInput();
  const params = { modelPolicy, modelStep, format, messages: context.messages, agentMode: "reasoning" as const, abortSignal: new AbortController().signal };
  expect(context.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
  await gateway.client.countInputTokens({ ...params, provider: "llamacpp" });
  await gateway.client.invoke(params);
  expectPackedMessages(gateway.exchanges, gateway.exchanges.at(-1)!, [3], template);
});

test("keeps a settled memory recall and user copy in order and rejects a later unmarked correction", async () => {
  const gateway = createGateway("first-system-only", ["ok"]);
  const { context, format, modelStep } = supervisorInput();
  const copied = context.messages[3]!.content;
  const recall = await settleRootRecall(await createRootInvalidOutputLedger("supervisor-worker-v1"));
  const [continuation] = projectMemoryRecallContinuations(recall);
  const receipt = continuation!.messages[1]!;
  if (receipt.role !== "tool") throw new Error("Missing settled recall result");
  const messages: ChatMessage[] = [...context.messages, { role: "user", content: copied }, ...continuation!.messages];
  const params = { modelPolicy, modelStep, format, messages, agentMode: "reasoning" as const, abortSignal: new AbortController().signal };
  await gateway.client.countInputTokens({ ...params, provider: "llamacpp" });
  await gateway.client.invoke(params);
  const [counted, dispatched] = gateway.exchanges;
  const sent = dispatched!.upstream.at(-1)!.payload;
  expect(sent).toEqual(counted!.upstream.at(-1)!.payload);
  expect(sent.messages.slice(-3)).toEqual([
    { role: "user", content: copied },
    { role: "assistant", content: "", tool_calls: [expect.objectContaining({
      id: receipt.toolCallId, function: expect.objectContaining({ name: "recall_memory" }),
    })] },
    { role: "tool", name: "recall_memory", tool_call_id: receipt.toolCallId,
      content: receipt.content },
  ]);
  expect(sent.messages[0]!.content).not.toContain(receipt.content);

  // Identical text has no runtime provenance just because an earlier clock reference had it.
  const repaired = { ...params, messages: [...messages, { role: "system", content: copied }] };
  const beforeRepair = gateway.exchanges.length;
  await expect(gateway.client.countInputTokens({ ...repaired, provider: "llamacpp" })).rejects.toThrow();
  await expect(gateway.client.invoke(repaired)).rejects.toThrow();
  const rejected = gateway.exchanges.slice(beforeRepair);
  expect(rejected.map(({ path, request }) => [path, request.invocationContextMessageIndices])).toEqual([
    ["/input-tokens", [3]], ["/chat", [3]],
  ]);
  for (const { request, upstream, rejection } of rejected) {
    expect(rejection).toEqual({ status: 400, reason: "llamacpp_system_message_order_unsupported" });
    expect(request.messages.slice(-4)).toEqual(repaired.messages.slice(-4));
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every(({ path }) => path === "/apply-template")).toBe(true);
  }
});

test.each(["first-system-only", "all-roles"] as const)(
  "SUPER retains Skill and empty recall evidence on fused routing re-entry on %s", async template => {
    const prompt = "Create an offline product explorer using the file tools.";
    const query = "Which local product data format did I prefer?";
    const decision = (value: Record<string, unknown>) => JSON.stringify({ decision: value });
    const gateway = createGateway(template, [
      decision({ action: "read_skills", skillIds: [PROCEDURE_SKILL.skillId], acknowledgement: "I will check the project requirements.", title: "Product explorer" }),
      decision({ action: "recall_memory", query }),
      decision({ action: "invoke_role", roleId: "worker", objective: "Create the four project files.", workingDirectory: ".", workerCapabilityScope: { catalogGroupIds: ["write"] } }),
    ]);
    const memory = createLongTermMemoryService({ enabled: true, emitClientEvents: false,
      repository: createInMemoryLongTermMemoryRepository(),
      embeddings: { embed: async ({ texts }) => ({ modelFingerprint: "fixture", dimensions: 2, vectors: texts.map(() => [1, 0]) }) },
    });
    const retrieve = vi.fn(memory.retrieve.bind(memory));
    const execute = vi.fn(async () => { throw new Error("unexpected_fixture_execution"); });
    const reachedWorker = new Error("Worker delegation accepted after the empty recall");
    const abort = new AbortController();
    const countInputTokens: typeof gateway.client.countInputTokens = input => {
      if (input.modelStep === "worker.decision") {
        abort.abort(reachedWorker);
        throw reachedWorker;
      }
      return gateway.client.countInputTokens(input);
    };
    const base = createRootInvalidOutputRequest(gateway.client.invoke, "supervisor-worker-v1", {
      prompt, modelPolicy, modelGatewayClient: { ...gateway.client, countInputTokens }, shouldGenerateSessionTitle: true, abortSignal: abort.signal,
      longTermMemory: { ...memory, retrieve },
      workerCapabilityProvider: { getDescriptors: () => PROCEDURE_CAPABILITIES,
        getAdapters: () => PROCEDURE_CAPABILITIES.map(descriptor => ({ descriptor, execute })) },
    });
    const store = { list: () => [PROCEDURE_SKILL], read: vi.fn(() => PROCEDURE_SKILL) };
    const request = createRequestExecutionScope({
      seed: base, executionPolicy: base.executionPolicy, knowledgeSkillStore: store,
      createWorkerCapabilities: () => base.workerCapabilities.provider,
    });
    await expect(runRequestRunner(request)).rejects.toBe(reachedWorker);
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(retrieve.mock.calls.map(([input]) => input.query)).toEqual([prompt, query]);

    const turns = gateway.exchanges.filter(({ path }) => path === "/chat");
    expect(turns.map(({ request }) => request.format?.name)).toEqual([
      "supervisor_fused_entry_with_memory_candidates", "supervisor_fused_routing", "supervisor_fused_routing",
    ]);
    const reentry = turns[2]!;
    const messages = reentry.request.messages;
    expect(messages.map(m => m.role)).toEqual(["system", "user", "system", "user", "assistant", "tool"]);
    const [policy, skill, brief, user, action, receipt] = messages;
    expect(skill).toEqual(turns[1]!.request.messages[1]);
    expect(brief!.content).toContain("runtime_capability_brief_v1");
    expect(reentry.request.invocationContextMessageIndices).toEqual([2]);
    expect(JSON.parse(skill!.content)).toMatchObject({
      kind: "runtime_core_skill_read_v1", document: { skillId: PROCEDURE_SKILL.skillId, content: PROCEDURE_SKILL.content },
    });
    expect(user).toEqual({ role: "user", content: prompt });
    if (action?.role !== "assistant" || receipt?.role !== "tool") throw new Error("Missing recall continuation");
    expect(action.toolCalls).toHaveLength(1);
    const call = action.toolCalls![0]!;
    expect(call).toMatchObject({ callId: "recall-1", name: "recall_memory" });
    expect(JSON.parse(call.arguments)).toEqual({ action: "recall_memory", query });
    expect(receipt).toMatchObject({ toolCallId: call.callId, toolName: call.name });
    expect(JSON.parse(receipt.content)).toMatchObject({
      kind: "runtime_memory_recall_reference_v1", authority: "passive_reference",
      presenceEffect: "not_user_intent_assignment_action_authority_or_completion_evidence",
      omittedRecallCount: 0, omittedRecordCount: 0,
      recalls: [{ recallId: call.callId, query, outcome: "empty", memories: [] }],
    });
    expect(receipt.content.length).toBeLessThanOrEqual(1_000);

    const counted = gateway.exchanges.find(({ path, request }) =>
      path === "/input-tokens" && isDeepStrictEqual(request, reentry.request))!;
    const measured = counted.upstream.find(({ path }) => path.endsWith("/input_tokens"))!.payload;
    const sent = reentry.upstream.find(({ path }) => path === "/v1/chat/completions")!.payload;
    expect(JSON.stringify(measured)).toBe(JSON.stringify(sent));
    const header = template === "all-roles" ? [policy, skill, brief, user] : [
      { role: "system", content: `${policy!.content}\n\n${brief!.content}` }, skill, user,
    ];
    expect(sent.messages).toEqual([
      ...header,
      { role: "assistant", content: "", tool_calls: [{ id: call.callId, type: "function",
        function: { name: call.name, arguments: call.arguments } }] },
      { role: "tool", name: call.name, tool_call_id: call.callId, content: receipt.content },
    ]);
    const rendered = renderLlamaCppTemplate(sent.messages, template);
    expect(rendered).toBe([
      ...header.map(message => `<|start|>${message!.role === "system" ? "developer" : message!.role}<|message|>${message!.content}<|end|>`),
      `<|start|>assistant to=functions.recall_memory<|message|>${call.arguments}<|call|>`,
      `<|start|>functions.recall_memory to=assistant<|message|>${receipt.content}<|end|>`,
    ].join(""));
    expect(rendered.split(query)).toHaveLength(3); // linked action and the exact settled receipt
    expect(rendered.split(receipt.content)).toHaveLength(2);
  },
);

test.each(["first-system-only", "all-roles"] as const)(
  "SUPER preserves the bound artifact and settled turn for a file follow-up on %s", async template => {
    const gateway = createGateway(template, ["ok", "ok"]);
    const { request } = createProcedureOrchestrationFixture(() => ({ action: "respond" }));
    const target = ".project/site/index.html";
    const scoped = { ...request, modelPolicy, prompt: "Update the file you just created.", sessionArtifactPaths: [target] };
    const options = { toolResults: { results: [], sourceRevision: 0 } };
    const input = buildSupervisorDelegationInput(scoped, options);
    const baseline = buildSupervisorDelegationInput({ ...scoped, sessionArtifactPaths: [] }, options);
    const readmission = createSupervisorArtifactPathsReadmissionController(scoped, {
      projection: input.artifactPathsProjection, format: input.format, includeInstructions: true,
      controller: { project: messages => [...messages], getStages: () => [] },
    });
    for (const messages of [input.context.messages, readmission.project(input.context.messages)]) {
      expect(messages.map(m => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
      expect(messages.slice(1, 3)).toEqual(baseline.context.messages.slice(1, 3));
      expect(messages.at(-1)).toEqual({ role: "user", content: scoped.prompt });
      expect(JSON.parse(messages[3]!.content)).toMatchObject({
        kind: "runtime_session_artifact_paths_v1", authority: "canonical_runtime_state", targets: [target],
        nonAuthority: { addsUserIntent: false, choosesOrRedirectsTarget: false },
      });
      const params = { modelPolicy, modelStep: input.modelStep, format: input.format, messages,
        agentMode: scoped.agentMode, abortSignal: scoped.abortSignal };
      await gateway.client.countInputTokens({ ...params, provider: "llamacpp" });
      await gateway.client.invoke(params);
      expectPackedMessages(gateway.exchanges, gateway.exchanges.at(-1)!, [3], template);
    }
    expect(baseline.context.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
  },
);

test.each(["first-system-only", "all-roles"] as const)(
  "SUPER presents a scheduled run with its bound job, run and prior conversation on %s", async template => {
    const gateway = createGateway(template, ["ok"]);
    const { request } = createProcedureOrchestrationFixture(() => ({ action: "respond" }));
    const ordinary = { ...request, modelPolicy, prompt: "Summarize the status.", historyMessages: request.historyMessages.slice(-2) };
    const origin = { jobId: "job-status", runId: "run-status-1", title: "Status", triggerType: "schedule" as const,
      scheduledAt: "2026-11-06T08:00:00.000Z" };
    const options = { call: { callId: "root", rootCallId: "root", parentCallId: null, depth: 0, invocationAttempt: 1 },
      toolResults: { results: [], sourceRevision: 0 } };
    const input = buildSupervisorResponseInput({ ...ordinary, scheduledExecution: origin }, options);
    const baseline = buildSupervisorResponseInput(ordinary, options);
    const messages = input.context.messages;
    expect(messages.map(m => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(messages.slice(1, 3)).toEqual(baseline.context.messages.slice(1, 3));
    expect(messages.at(-1)).toEqual({ role: "user", content: ordinary.prompt });
    expect(JSON.parse(messages[3]!.content)).toMatchObject({
      kind: "runtime_scheduled_execution_v1", authority: "runtime_scheduler",
      requestId: ordinary.requestId, jobId: origin.jobId, runId: origin.runId,
    });
    expect(baseline.context.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
    const params = { modelPolicy, modelStep: input.modelStep, messages, agentMode: ordinary.agentMode, abortSignal: ordinary.abortSignal };
    await gateway.client.countInputTokens({ ...params, provider: "llamacpp" });
    await gateway.client.invoke(params);
    expectPackedMessages(gateway.exchanges, gateway.exchanges.at(-1)!, [3], template);
  },
);
