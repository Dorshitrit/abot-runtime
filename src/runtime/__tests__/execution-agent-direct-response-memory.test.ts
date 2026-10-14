import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import * as candidateProcessing from "../long-term-memory/candidate-processing.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { scheduleFinalResponseMemory } from "../long-term-memory/finalization.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient, ToolRegistry } from "../ports.js";
import { handleRunRequest } from "../request/handler.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { INVALID_OUTPUT_MODEL_POLICY } from "./support/root-invalid-output-fixture.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const liveMemory: LongTermMemoryService[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const memory of liveMemory.splice(0)) await memory.retention?.stop();
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

const REQUEST_ID = "direct-memory-request";
const SESSION_ID = "direct-memory-session";
const ANSWER = "A concise explanation.";
const INITIAL_MEMORY = "The user prefers metric units.";
const CANDIDATE = {
  content: "The user prefers concise explanations.", tags: ["style"], target: null,
  score: 90, reason: "The user states this preference in the current request.",
  reinforced: true, explicitRequestQuote: null,
};
type Scenario = "direct" | "deferred" | "tool" | "retry" | "steer" | "cancel" | "provider_failure" | "persistence_failure";
const decision = (body: Record<string, unknown>, acknowledge = true) => JSON.stringify({
  decision: { ...(acknowledge ? { acknowledgement: "I will answer." } : {}), ...body },
});
const authored = (content = CANDIDATE.content) => JSON.stringify({
  finalResponse: ANSWER, memoryCandidates: [{ ...CANDIDATE, content }],
});

async function memoryHandlerFixture(enabled: boolean, scenario: Scenario) {
  const repository = createInMemoryLongTermMemoryRepository();
  await repository.update(() => ({ records: [{
    id: "initial-units", content: INITIAL_MEMORY, tags: ["units"],
    provenance: { kind: "passive_response", sourceRequestId: "prior", sourceSessionId: "prior" },
    createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z",
  }], vectors: [{ memoryId: "initial-units", modelFingerprint: "local-memory-fixture",
    dimensions: 2, vector: [1, 0] }] }));
  const processor = vi.spyOn(candidateProcessing, "processMemoryCandidates");
  const embeddings = { embed: vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "local-memory-fixture", dimensions: 2, vectors: texts.map(() => [1, 0]),
  })) };
  const realMemory = createLongTermMemoryService({
    repository, embeddings, enabled, emitClientEvents: false,
  });
  liveMemory.push(realMemory);
  await realMemory.retention!.start();
  const timeline: string[] = [];
  const preparationOrder: string[] = [];
  const prepare = vi.fn<NonNullable<LongTermMemoryService["learning"]>["prepare"]>(async (input) => {
    preparationOrder.push("prepare");
    return realMemory.learning!.prepare(input);
  });
  const memory: LongTermMemoryService & {
    retrieve: ReturnType<typeof vi.fn<LongTermMemoryService["retrieve"]>>;
    scheduleCandidates: ReturnType<typeof vi.fn<LongTermMemoryService["scheduleCandidates"]>>;
    processCandidates: ReturnType<typeof vi.fn<LongTermMemoryService["processCandidates"]>>;
  } = {
    ...realMemory,
    learning: { ...realMemory.learning!, prepare },
    retrieve: vi.fn<LongTermMemoryService["retrieve"]>(async (input) => {
      preparationOrder.push("retrieve");
      return realMemory.retrieve(input);
    }),
    processCandidates: vi.fn(realMemory.processCandidates),
    scheduleCandidates: vi.fn((input) => {
      expect(timeline).toContain("assistant_persisted");
      timeline.push("memory_queued");
      realMemory.scheduleCandidates(input);
    }),
  };
  const sessions = createInMemorySessionStore();
  await sessions.getOrCreateSession(SESSION_ID);
  await sessions.updateSessionTitle(SESSION_ID, "Existing conversation");
  const append = sessions.appendMessage.bind(sessions);
  vi.spyOn(sessions, "appendMessage").mockImplementation(async (...args) => {
    if (args[1] === "assistant" && scenario === "persistence_failure")
      throw new Error("fixture_response_persistence_failed");
    const result = await append(...args);
    if (args[1] === "assistant") timeline.push("assistant_persisted");
    return result;
  });
  const abort = new AbortController();
  const steering = createRequestSteeringInbox({ requestId: REQUEST_ID });
  const registration: RegisteredToolNormalInvocation = {
    toolName: "memory_fixture_observe",
    definition: {
      name: "memory_fixture_observe", routingCapability: "filesystem_inspection",
      executionEffect: "read_only", params: {}, catalogGroups: ["other"],
    },
    contract: { version: 1, operations: [{
      operationId: "memory_fixture_observe", summary: "Observe the requested fixture.",
      effect: "read_only", approval: "request_policy",
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
    }] },
  };
  const execute = vi.fn<ToolRegistry["execute"]>(async () => ({
    ok: true, tool: registration.toolName, output: "The fixture was observed.",
    producedNewInformation: true,
  }));
  const registrations = scenario === "tool" ? [registration] : [];
  const toolRegistry: ToolRegistry = {
    listDefinitions: () => registrations.map(({ definition }) => definition),
    listNormalInvocations: () => registrations,
    getDefinition: (name) => registrations.find(({ toolName }) => name === toolName)?.definition,
    hasToolsAvailable: () => registrations.length > 0, getImplementations: () => ({}), execute,
  };
  let decisions = 0;
  let responses = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    preparationOrder.push(String(input.modelStep));
    if (enabled) {
      expect(JSON.stringify(input.messages)).toContain(INITIAL_MEMORY);
      expect(memory.retrieve).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(preparationOrder.slice(0, 2)).toEqual(["retrieve", "prepare"]);
    }
    expect(memory.scheduleCandidates).not.toHaveBeenCalled();
    expect(memory.processCandidates).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
    expect((await repository.read()).learningCandidates ?? []).toHaveLength(0);
    if (input.modelStep === "execution.decision") {
      decisions += 1;
      if (enabled && decisions === 1) {
        const schema = input.format as { schema: { properties: { decision: { anyOf: {
          properties: { action: { enum: string[] }; response?: unknown };
        }[] } } } };
        expect(schema.schema.properties.decision.anyOf.filter(({ properties }) =>
          properties.action.enum.includes("respond") && properties.response !== undefined)).toHaveLength(1);
      }
      if (scenario === "tool" && decisions === 1)
        return { text: decision({ action: "open_capability_scope", catalogGroupIds: ["other"] }), meta: {} };
      if (scenario === "tool" && decisions === 2)
        return { text: decision({ action: "invoke_capability", capabilityId: registration.toolName,
          intent: "Observe the requested fixture.", workingDirectory: "." }, false), meta: {} };
      return { text: decision({ action: "respond", ...(scenario === "direct" ? {
        response: ANSWER, ...(enabled ? { memoryCandidates: [CANDIDATE] } : {}),
      } : {}) },
        scenario !== "tool"), meta: {} };
    }
    expect(input.modelStep).toBe("execution.response");
    responses += 1;
    if (scenario === "retry" && responses === 1) return { text: "invalid", meta: {} };
    if (scenario === "steer" && responses === 1) {
      steering.append({ steerId: "updated", text: "Keep the explanation concise and include an example." });
      return { text: authored("STALE preference."), meta: {} };
    }
    if (scenario === "cancel") abort.abort(new Error("cancel_before_memory_commit"));
    if (scenario === "provider_failure") throw new Error("fixture_provider_failed");
    return { text: enabled ? authored() : ANSWER, meta: {} };
  });
  const runtimeConfig = {
    ...(await createRuntimeConfig()), plugins: { enabled: false },
    models: INVALID_OUTPUT_MODEL_POLICY,
    modelExecutionPolicies: { "invalid-output-test": { policy: "execution-agent-v1" as const } },
  };
  await writeFile(runtimeConfig.requestRunner.configPath!, JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "invalid-output-test", steps: {} } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 20000 }, steps: {},
  }));
  const events: Record<string, unknown>[] = [];
  const ws = { send(data: string) {
    const event = JSON.parse(data) as Record<string, unknown>;
    events.push(event);
    if (event.type === "completed") timeline.push("completed");
  } } as unknown as WebSocket;
  const run = () => handleRunRequest(ws, {
    type: "run_request", requestId: REQUEST_ID, sessionId: SESSION_ID,
    input: "I prefer concise explanations. Explain gravity.",
    agentMode: "reasoning", modelPreference: { profileId: "invalid-output-test", scope: "all" },
    toolPermissionMode: "full_access",
  }, {
    runtimeConfig, sessionStore: sessions, modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    longTermMemory: memory, toolRegistry, requestSteering: steering, abortSignal: abort.signal,
  });
  return { run, memory, prepare, processor, repository, invoke, execute, sessions, events, timeline, preparationOrder };
}

test.each(["direct", "deferred"] as const)("memory disabled: %s answer never retrieves, authors candidates or saves", async (scenario) => {
  const f = await memoryHandlerFixture(false, scenario);
  await f.run();
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(
    scenario === "direct" ? ["execution.decision"] : ["execution.decision", "execution.response"],
  );
  expect(f.memory.retrieve).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
  expect(f.memory.processCandidates).not.toHaveBeenCalled();
  expect(f.processor).not.toHaveBeenCalled();
  expect((await f.repository.read()).learningCandidates ?? []).toEqual([]);
  expect(f.events.filter(({ type }) => type === "completed")).toEqual([
    expect.objectContaining({ output: ANSWER }),
  ]);
});

test.each([
  ["direct", 1, 0, 1], ["deferred", 1, 1, 1], ["tool", 3, 1, 1], ["retry", 1, 2, 1], ["steer", 2, 2, 1],
] as const)("memory enabled: %s schedules and persists only accepted candidates once", async (scenario, decisions, responses, retrievals) => {
  const f = await memoryHandlerFixture(true, scenario);
  await f.run();
  expect(f.events.filter(({ type }) => type === "failed")).toEqual([]);
  await vi.waitFor(() => expect(f.processor).toHaveBeenCalledOnce());
  await f.processor.mock.results[0]!.value;
  expect(f.memory.retrieve).toHaveBeenCalledTimes(retrievals);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.preparationOrder.slice(0, 3)).toEqual(["retrieve", "prepare", "execution.decision"]);
  expect(f.invoke.mock.calls.filter(([input]) => input.modelStep === "execution.decision")).toHaveLength(decisions);
  expect(f.invoke.mock.calls.filter(([input]) => input.modelStep === "execution.response")).toHaveLength(responses);
  expect(f.execute).toHaveBeenCalledTimes(scenario === "tool" ? 1 : 0);
  expect(f.memory.scheduleCandidates).toHaveBeenCalledOnce();
  expect(f.memory.processCandidates).not.toHaveBeenCalled();
  expect(f.processor).toHaveBeenCalledOnce();
  const snapshot = await f.repository.read();
  expect(snapshot.learningCandidates).toHaveLength(1);
  expect(snapshot.learningCandidates![0]).toMatchObject({
    content: CANDIDATE.content, sources: [expect.objectContaining({
      sourceRequestId: REQUEST_ID, sourceSessionId: SESSION_ID,
    })],
  });
  expect(snapshot.learningReceipts).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toContain("STALE");
  expect(f.timeline).toEqual(["assistant_persisted", "memory_queued", "completed"]);
  const session = await f.sessions.getSessionById(SESSION_ID);
  expect(session!.messages.filter(({ role }) => role === "assistant")).toEqual([
    expect.objectContaining({ content: ANSWER }),
  ]);
});

test.each(["cancel", "provider_failure", "persistence_failure"] as const)(
  "%s after memory preparation never queues or writes an authored candidate",
  async (scenario) => {
    const f = await memoryHandlerFixture(true, scenario);
    await f.run();
    expect(f.memory.retrieve).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
    expect(f.memory.processCandidates).not.toHaveBeenCalled();
    expect(f.processor).not.toHaveBeenCalled();
    expect((await f.repository.read()).learningCandidates ?? []).toEqual([]);
    expect(f.events.filter(({ type }) => type === "completed")).toEqual([]);
  },
);

test("replayed final memory scheduling can process twice while the automatic mutation commits once", async () => {
  const f = await memoryHandlerFixture(true, "deferred");
  await f.run();
  expect(f.events.filter(({ type }) => type === "failed")).toEqual([]);
  await vi.waitFor(() => expect(f.processor).toHaveBeenCalledOnce());
  await f.processor.mock.results[0]!.value;
  const before = await f.repository.read();
  const original = f.memory.scheduleCandidates.mock.calls[0]![0];
  scheduleFinalResponseMemory({
    service: f.memory, candidates: original.candidates,
    requestId: REQUEST_ID, sessionId: SESSION_ID,
  });
  await vi.waitFor(() => expect(f.processor).toHaveBeenCalledTimes(2));
  await f.processor.mock.results[1]!.value;
  expect(f.memory.scheduleCandidates).toHaveBeenCalledTimes(2);
  const after = await f.repository.read();
  expect(after.learningCandidates).toEqual(before.learningCandidates);
  expect(after.learningReceipts).toEqual(before.learningReceipts);
  expect(after.learningCandidates).toHaveLength(1);
  expect(after.learningReceipts).toHaveLength(1);
  expect(f.memory.retrieve).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledOnce();
});
