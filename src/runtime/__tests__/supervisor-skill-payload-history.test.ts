import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import { bindSuperWorkerCompactionSources } from "../context/super-worker-compaction-sidecar.js";
import { createRoleCallLedger, type RoleCallLedger } from "../orchestration/role-calls/index.js";
import { createPreparationId } from "../orchestration/worker-capabilities/execution/invocation-preparation.js";
import type { WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/payload-contracts.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import { projectRoleSettledCapabilityResults } from "../orchestration/worker-capabilities/settled-results.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope, type RequestExecutionScope } from "../request/execution-scope.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture, CORE_SKILL_DOCUMENT } from "./support/core-skill-read-context-fixture.js";
import { memoryFor, ordinaryTurn, session } from "./support/initiative-session-memory-fixture.js";
import { deriveTestRequestExecutionScope, rebindTestRequestExecutionPolicy } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createCoreSkillContextFixture>>;
type PayloadInput = Parameters<WorkerCapabilityPayloadAuthor["author"]>[0];
const EARLIER_GUIDANCE = "EARLIER_GUIDANCE: always distinguish confirmed facts from assumptions.";
const SUMMARY = `Saved conversation guidance: ${EARLIER_GUIDANCE}`;

function history(turns = 3): RequestHistoryMessage[] {
  return Array.from({ length: turns }, (_, index) => ordinaryTurn(index)).flat().map((message, index) => ({
    ...message, content: index === 0 ? EARLIER_GUIDANCE : `${message.content} [history-${index}]`,
  }));
}

function payloadInput(ledger: RoleCallLedger, options: {
  capabilityId?: string; contextScope?: "standard" | "target_only";
} = {}): PayloadInput {
  const call = activeCoreSkillCall(ledger);
  const capabilityId = options.capabilityId ?? "create_skill";
  const contextScope = options.contextScope ?? "standard";
  return {
    call, executionId: createPreparationId(call, 0), contextScope,
    authoringObjective: "Produce the requested reusable guidance.",
    descriptor: { capabilityId, summary: "Write the requested document.", effect: "mutation",
      requiresPayloadAuthoringObjective: true,
      controls: { type: "object", additionalProperties: false, properties: {}, required: [] } },
    controls: capabilityId === "update_skill"
      ? { skillId: CORE_SKILL_DOCUMENT.skillId, expectedRevision: CORE_SKILL_DOCUMENT.revision } : {},
    ...(call.roleId === "worker" ? { assignmentProvenance: projectWorkerCapabilityPayloadSourceProvenance({
      ledger, head: ledger.current(), call,
    }) } : {}),
    settledCapabilityResults: bindSuperWorkerCompactionSources([...projectRoleSettledCapabilityResults({
      ledger, head: ledger.current(), call,
    })], ledger.current(), call.callId),
    contract: { instructions: "Return the complete Markdown document.", minBytes: 1, maxBytes: 4096 },
    ...(call.parentCallId === null ? { requestSteering: {
      kind: "request_steering_v1" as const, version: 0, updates: [],
    } } : {}),
    ...(contextScope === "target_only" ? {
      stage: { index: 1, count: 1, outputParam: "content", contextScope },
      targetContext: { targetParam: "skillId", targetPath: "personal-target", presentation: "full" as const,
        content: "Exact target body." },
    } : {}),
  };
}

async function authorThroughComposition(fixture: Fixture, request: RequestExecutionScope, input: PayloadInput) {
  let author!: WorkerCapabilityPayloadAuthor;
  createRequestExecutionScope({
    seed: request, executionPolicy: request.executionPolicy,
    createWorkerCapabilities(view) {
      author = createRequestWorkerCapabilityPayloadAuthor(view, ["root", "worker"]);
      return fixture.request.workerCapabilities.provider;
    },
  });
  const before = fixture.modelInputs.length;
  const result = await author.author(input);
  expect(result, JSON.stringify(result)).toMatchObject({ status: "authored" });
  const calls = fixture.modelInputs.slice(before);
  expect(calls.map(({ step }) => step)).toEqual(["tool_payload.raw"]);
  return calls[0]!.messages;
}

function requestSource(messages: readonly ChatMessage[]) {
  const message = messages.find(({ content }) => content.startsWith('{"kind":"runtime_request_source_v1"'));
  expect(message).toBeDefined();
  return JSON.parse(message!.content) as Record<string, unknown>;
}

function occurrences(messages: readonly ChatMessage[], text: string) {
  return messages.reduce((count, message) => count + message.content.split(text).length - 1, 0);
}

test.each(["create_skill", "update_skill"])("SUPER %s RAW receives earlier turns through its composition view once", async (capabilityId) => {
  const fixture = await createCoreSkillContextFixture();
  if (capabilityId === "update_skill") await fixture.read();
  const previous = history();
  const request = deriveTestRequestExecutionScope(fixture.request, { historyMessages: previous });
  const messages = await authorThroughComposition(fixture, request, payloadInput(fixture.ledger, { capabilityId }));
  for (const entry of previous) {
    expect(messages).toContainEqual({ role: entry.role, content: entry.content });
    expect(occurrences(messages, entry.content)).toBe(1);
  }
  expect(occurrences(messages, request.prompt)).toBe(1);
  expect(requestSource(messages)).toMatchObject({ currentRequest: request.prompt });
  expect(requestSource(messages)).not.toHaveProperty("precedingTurn");
  const counted = fixture.countInputTokens.mock.calls.find(([input]) => input.modelStep === "tool_payload.raw")![0];
  expect((counted.messages as readonly ChatMessage[]).some(({ content }) => content === EARLIER_GUIDANCE)).toBe(true);
});

test("SUPER Skill RAW reuses the existing session checkpoint and only its uncovered turns", async () => {
  const fixture = await createCoreSkillContextFixture();
  const previous = history(12);
  const record = session(previous);
  const memory = memoryFor(record);
  memory.compact.mockResolvedValue(SUMMARY);
  await (await memory.memory.prepare(fixture.request)).commit();
  memory.compact.mockClear();
  const request = deriveTestRequestExecutionScope(fixture.request, {
    sessionId: record.id, historyMessages: previous, sessionMemory: memory.memory,
  });
  const messages = await authorThroughComposition(fixture, request, payloadInput(fixture.ledger));
  const projection = memory.memory.project();
  for (const message of projection.priorConversationMessages) expect(messages).toContainEqual(message);
  expect(projection.priorConversationMessages).toHaveLength(1);
  for (const entry of projection.historyMessages) {
    expect(messages).toContainEqual({ role: entry.role, content: entry.content });
    expect(occurrences(messages, entry.content)).toBe(1);
  }
  expect(messages.some(({ content }) => content === previous[0]!.content)).toBe(false);
  expect(occurrences(messages, EARLIER_GUIDANCE)).toBe(1);
  expect(occurrences(messages, request.prompt)).toBe(1);
  expect(requestSource(messages)).not.toHaveProperty("precedingTurn");
  expect(memory.compact).not.toHaveBeenCalled();
});

test("SUPER Skill RAW compacts older session history through its existing owner before dispatch", async () => {
  const fixture = await createCoreSkillContextFixture();
  const previous = history(12);
  const record = session(previous);
  const memory = memoryFor(record);
  memory.compact.mockResolvedValue(SUMMARY);
  const request = deriveTestRequestExecutionScope(fixture.request, {
    sessionId: record.id, historyMessages: previous, sessionMemory: memory.memory,
  });
  const count = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) => input.modelStep !== "tool_payload.raw" ? count(input) : {
    inputTokens: (input.messages as readonly ChatMessage[]).some(({ content }) => content === EARLIER_GUIDANCE) ? 64_000 : 1_000,
    profileId: "contract-model", provider: "openai", model: "contract-test", contextWindowTokens: 64_000,
    source: "provider_input_token_count",
  });
  const messages = await authorThroughComposition(fixture, request, payloadInput(fixture.ledger));
  expect(memory.compact).toHaveBeenCalledOnce();
  expect(memory.compact.mock.calls[0]![0].turns).toHaveLength(2);
  expect(memory.compact.mock.calls[0]![0].turns[0]!.userMessages[0]!.content).toBe(EARLIER_GUIDANCE);
  expect(record.sessionMemoryCheckpoint).toMatchObject({ revision: 1, summary: SUMMARY });
  expect(messages.some(({ content }) => content === EARLIER_GUIDANCE)).toBe(false);
  expect(occurrences(messages, SUMMARY)).toBe(1);
  for (const entry of previous.slice(4)) expect(messages).toContainEqual({ role: entry.role, content: entry.content });
  expect(occurrences(messages, previous.at(-2)!.content)).toBe(1);
  expect(occurrences(messages, previous.at(-1)!.content)).toBe(1);
  expect(occurrences(messages, request.prompt)).toBe(1);
  expect(requestSource(messages)).not.toHaveProperty("precedingTurn");
  expect(fixture.store.snapshot!().checkpoints).toEqual([]);
});

test.each(["EA root", "Worker", "unrelated SUPER root", "target_only"] as const)(
  "%s RAW retains its previous input when session memory is available", async (kind) => {
    const fixture = await createCoreSkillContextFixture();
    const previous = history(12);
    const record = session(previous);
    const memory = memoryFor(record);
    memory.compact.mockResolvedValue(SUMMARY);
    await (await memory.memory.prepare(fixture.request)).commit();
    memory.compact.mockClear();
    let request = deriveTestRequestExecutionScope(fixture.request, { sessionId: record.id, historyMessages: previous });
    let ledger = fixture.ledger;
    if (kind === "EA root") {
      request = rebindTestRequestExecutionPolicy(request, EXECUTION_AGENT_V1_EXECUTION_POLICY);
      ledger = createRoleCallLedger({ requestId: request.requestId, policy: createRequestRoleCallPolicy(request.executionPolicy) });
      await commitSkillFixture(ledger, { authority: "runtime", type: "create_root" });
    }
    if (kind === "Worker") await fixture.open("worker");
    const input = payloadInput(ledger, {
      ...(kind === "unrelated SUPER root" || kind === "Worker" ? { capabilityId: "write_file" } : {}),
      ...(kind === "target_only" ? { contextScope: "target_only" } : {}),
    });
    const baseline = await authorThroughComposition(fixture, request, input);
    const withMemory = deriveTestRequestExecutionScope(request, { sessionMemory: memory.memory });
    const messages = await authorThroughComposition(fixture, withMemory, input);
    expect(messages).toEqual(baseline);
    expect(occurrences(messages, EARLIER_GUIDANCE)).toBe(0);
    expect(memory.compact).not.toHaveBeenCalled();
  },
);
