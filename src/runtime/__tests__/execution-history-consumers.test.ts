import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { SessionRecord } from "../../sessions/types.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "../../sessions/memory/execution-observation.js";
import { createRequestSessionMemory, type SessionMemoryCompactor } from "../context/session-memory/index.js";
import { buildRequestSourceMessage, projectRequestSource } from "../context/request-source.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  activeEvidenceCall, controlsReply, createControlsEvidenceFixture, evidenceDescriptor, runtimeCapsule,
} from "./support/execution-controls-evidence-fixture.js";

const DETAIL = "source-only fact: archive code R72-938";
const ANSWER = "I found the requested source.";
const SUMMARY = `Earlier source lookup established ${DETAIL}.`;
const INTERVENING_QUESTION = "What is two plus two?";
const INTERVENING_ANSWER = "Four.";
const writer = {
  capabilityId: "write_complete_file", summary: "Write the selected file.",
  effect: "mutation" as const, requiresPayloadAuthoringObjective: true as const,
  controls: {
    type: "object" as const, additionalProperties: false as const,
    properties: { path: { type: "string" as const, minLength: 1 } }, required: ["path"],
  },
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([false, true])("EA raw/compacted history (%s) reaches decision, response, Controls and RAW after an intervening turn", async (compacted) => {
  const fixture = await historyFixture();
  expect(fixture.session.messages.map(({ content }) => content).join("\n")).not.toContain(DETAIL);
  if (compacted) {
    const prepared = await fixture.memory.prepare(fixture.request);
    await prepared.commit();
    expect(JSON.stringify(fixture.compact.mock.calls[0]![0].turns)).toContain(DETAIL);
  }
  const head = fixture.ledger.current();
  const options = { head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot() };
  const decision = buildExecutionAgentInput(fixture.request, {
    ...options, includeAcknowledgement: false, includeTitle: false, allowPlanner: false, allowAuditor: false,
  });
  const response = buildExecutionAgentResponseInput(fixture.request, options);
  for (const messages of [decision.messages, response.messages]) {
    expect(text(messages)).toContain(compacted ? SUMMARY : DETAIL);
    expect(messages.filter(({ role }) => role === "tool")).toEqual([]);
  }
  fixture.invoke.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    expectHistoricalReferences(messages, compacted);
    expect(runtimeCapsule(messages, "runtime_request_tool_results_v1")).toBeUndefined();
    return controlsReply({ query: DETAIL });
  });
  const refined = await refine(fixture);
  expect(refined.invocations[0]!.controls).toEqual({ path: "new.txt", query: DETAIL });
  fixture.invoke.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    expect(input.modelStep).toBe("tool_payload.raw");
    expectHistoricalReferences(messages, compacted);
    const canonical = messages.find(({ content }) => content.startsWith("Canonical runtime context:"))!;
    const context = JSON.parse(canonical.content.slice(canonical.content.indexOf("\n") + 1));
    expect(context.settledCapabilityResults).toEqual([]);
    expect(context.acceptedCapability.controls).toEqual({ path: "new.txt" });
    expect(context.acceptedCapability.authoringObjective).toBe("Write the collected source fact into the selected file.");
    return { text: DETAIL, meta: {} };
  });
  await expect(author(fixture)).resolves.toEqual({ status: "authored", body: DETAIL });
  expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
});

test("Controls admission compacts prior tool facts through the existing history controller", async () => {
  const fixture = await historyFixture();
  fixture.counts.push(30_000, 1_000);
  fixture.invoke.mockImplementation(async (input) => {
    expectHistoricalReferences(input.messages as readonly ChatMessage[], true);
    return controlsReply({ query: DETAIL });
  });
  await refine(fixture);
  expect(fixture.compact).toHaveBeenCalledOnce();
  expect(fixture.memory.project().historyMessages).toEqual([]);
});

test("RAW admission compacts historical tool facts without an active execution result", async () => {
  const fixture = await historyFixture();
  fixture.counts.push(30_000, 1_000);
  fixture.invoke.mockImplementation(async (input) => {
    expectHistoricalReferences(input.messages as readonly ChatMessage[], true);
    return { text: DETAIL, meta: {} };
  });
  await expect(author(fixture)).resolves.toEqual({ status: "authored", body: DETAIL });
  expect(fixture.compact).toHaveBeenCalledOnce();
});

test("SUPER payload is byte-identical with and without EA tool-observation metadata", async () => {
  const captured: string[] = [];
  for (const includeObservation of [false, true]) {
    const fixture = await historyFixture(includeObservation, false);
    fixture.invoke.mockImplementation(async (input) => {
      captured.push(JSON.stringify(input.messages));
      return { text: "same authored body", meta: {} };
    });
    await expect(author(fixture, "supervisor-worker-v1")).resolves.toEqual({ status: "authored", body: "same authored body" });
    expect(fixture.compact).not.toHaveBeenCalled();
  }
  expect(captured).toHaveLength(2);
  expect(captured[0]).toBe(captured[1]);
  expect(captured[1]).not.toContain(DETAIL);
});

test.each([
  { label: "empty EA history", empty: true, large: false, legacy: false },
  { label: "large unrelated conversation without tool observations", empty: false, large: true, legacy: false },
  { label: "restored scope-less approval snapshot", empty: false, large: false, legacy: true },
])("Controls and RAW preserve baseline reference inputs for $label", async ({ empty, large, legacy }) => {
  const olderQuestion = "OLDER_UNRELATED_REQUEST";
  const olderAnswer = "OLDER_UNRELATED_ANSWER";
  const messages = historySession(legacy).messages.map((message, index) => large && index < 2
    ? { ...message, content: index === 0 ? `${olderQuestion} ${"unrelated ".repeat(12_000)}` : olderAnswer }
    : message);
  const fixture = await historyFixture(legacy, !legacy, {
    messages: empty ? [] : messages, restoreSnapshot: legacy,
  });
  if (legacy) expect(fixture.memory.snapshot!()).not.toHaveProperty("scope");
  fixture.countInputTokens.mockImplementation(async (input) => ({
    inputTokens: JSON.stringify(input.messages).includes(olderQuestion) ? 30_000 : 1_000,
    profileId: "test", provider: "openai", model: "test", contextWindowTokens: 32_000,
    source: "provider_input_token_count",
  }));
  const actual = await captureAuthoringInputs(fixture);
  const baseline = await captureAuthoringInputs({
    ...fixture, request: deriveTestRequestExecutionScope(fixture.request, { sessionMemory: undefined }),
  });
  expect(actual).toEqual(baseline);
  expect(fixture.compact).not.toHaveBeenCalled();
  for (const [modelStep, inputs] of Object.entries(actual)) {
    const expectedSource = buildRequestSourceMessage(projectRequestSource({
      requestId: fixture.request.requestId, prompt: fixture.request.prompt,
      modelStep: modelStep as "capability.controls" | "tool_payload.raw", callId: "baseline-reference",
      historyMessages: fixture.request.historyMessages,
    }));
    expect(inputs.filter(({ content }) => content === expectedSource.content)).toEqual([expectedSource]);
    expect(inputs.filter(({ role }) => role === "assistant" || role === "tool")).toEqual([]);
    const contents = text(inputs);
    expect(contents).not.toContain(DETAIL);
    expect(contents).not.toContain(ANSWER);
    expect(contents).not.toContain("Find the archive record.");
    expect(contents).not.toContain(olderQuestion);
    expect(contents).not.toContain(olderAnswer);
    const source = runtimeCapsule(inputs, "runtime_request_source_v1")!;
    if (empty) expect(source).not.toHaveProperty("precedingTurn");
    else expect(source.precedingTurn).toEqual({
      user: { id: "other-user", requestId: "other-request", content: INTERVENING_QUESTION },
      assistant: { id: "other-assistant", requestId: "other-request", content: INTERVENING_ANSWER },
    });
  }
});

async function historyFixture(includeObservation = true, executionScope = true, options: {
  messages?: SessionRecord["messages"];
  restoreSnapshot?: boolean;
} = {}) {
  const original = historySession(includeObservation);
  const session = options.messages
    ? { ...original, messages: options.messages, messageCount: options.messages.length }
    : original;
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => SUMMARY);
  const repository: Parameters<typeof createRequestSessionMemory>[0]["repository"] = {
    compareAndSwapSessionMemoryCheckpoint: async (_id, command) => ({ committed: true, checkpoint: command.checkpoint }),
  };
  const initialMemory = createRequestSessionMemory({
    sessionId: session.id, session, ...(executionScope ? { scope: "execution_agent" as const } : {}),
    compactor: { compact }, repository,
  });
  const memory = options.restoreSnapshot ? createRequestSessionMemory({
    sessionId: session.id, snapshot: initialMemory.snapshot!(), compactor: { compact }, repository,
  }) : initialMemory;
  const fixture = await createControlsEvidenceFixture({
    prompt: "Write the code from the earlier source into new.txt.",
    sessionId: session.id, sessionMemory: memory,
    historyMessages: session.messages.map(({ id, role, content, createdAt, requestId }) => ({ id, role, content, createdAt, requestId })),
  });
  const request = deriveTestRequestExecutionScope(fixture.request, {
    runnerConfig: { ...fixture.request.runnerConfig,
      steps: { ...fixture.request.runnerConfig.steps, "tool_payload.raw": { timeoutMs: 20_000 } },
    },
  });
  return { ...fixture, request, session, memory, compact };
}

type HistoryFixture = Awaited<ReturnType<typeof historyFixture>>;

async function captureAuthoringInputs(fixture: HistoryFixture) {
  const captured: Record<string, readonly ChatMessage[]> = {};
  fixture.invoke.mockImplementation(async (input) => {
    captured[input.modelStep!] = input.messages as readonly ChatMessage[];
    return input.modelStep === "tool_payload.raw"
      ? { text: "baseline authored body", meta: {} }
      : controlsReply({ query: "baseline query" });
  });
  await refine(fixture);
  await expect(author(fixture)).resolves.toEqual({ status: "authored", body: "baseline authored body" });
  expect(Object.keys(captured)).toEqual(["capability.controls", "tool_payload.raw"]);
  return captured;
}

function refine(fixture: HistoryFixture) {
  const head = fixture.ledger.current();
  return refineExecutionCapabilityInvocations(fixture.request, {
    head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot(),
    capabilities: [evidenceDescriptor], eligibleSessionArtifactPaths: [],
    invocations: [{
      capabilityId: evidenceDescriptor.capabilityId,
      operationObjective: "Use the collected source fact.", selectionControls: { path: "new.txt" },
      controlsEvidenceExecutionIds: [],
    }],
  });
}

function author(fixture: HistoryFixture, policyId: "execution-agent-v1" | "supervisor-worker-v1" = "execution-agent-v1") {
  const authority = resolveRequestExecutionPolicy(policyId).authority;
  return createRequestWorkerCapabilityPayloadAuthor(fixture.request, ["root"], undefined, authority).author({
    call: activeEvidenceCall(fixture.ledger.current()), executionId: "new-write", descriptor: writer,
    controls: { path: "new.txt" }, authoringObjective: "Write the collected source fact into the selected file.",
    contract: { instructions: "Write the requested body.", minBytes: 1, maxBytes: 4096 },
    settledCapabilityResults: [], requestSteering: { kind: "request_steering_v1", version: 0, updates: [] },
  });
}

function historySession(includeObservation: boolean): SessionRecord {
  const createdAt = "2026-10-27T09:00:00.000Z";
  const observationContent = JSON.stringify({
    kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "lookup-request",
    results: [{ executionId: "old-lookup", capabilityId: "source.lookup", outcome: "succeeded", referenceData: DETAIL }],
  });
  const messages: SessionRecord["messages"] = [
    { id: "lookup-user", role: "user", content: "Find the archive record.", createdAt, requestId: "lookup-request" },
    { id: "lookup-assistant", role: "assistant", content: ANSWER, createdAt, requestId: "lookup-request",
      ...(includeObservation ? { observationContent } : {}) },
    { id: "other-user", role: "user", content: INTERVENING_QUESTION, createdAt, requestId: "other-request" },
    { id: "other-assistant", role: "assistant", content: INTERVENING_ANSWER, createdAt, requestId: "other-request" },
  ];
  return { id: "history-consumer-session", title: "History", createdAt, updatedAt: createdAt,
    lastAgentMode: "reasoning", messageCount: messages.length, messages };
}

function text(messages: readonly ChatMessage[]) {
  return messages.map(({ content }) => content).join("\n");
}

function expectHistoricalReferences(messages: readonly ChatMessage[], compacted: boolean) {
  const contents = text(messages);
  expect(contents.split(DETAIL)).toHaveLength(2);
  expect(messages.filter(({ role }) => role === "assistant" || role === "tool")).toEqual([]);
  expect(contents).not.toContain(ANSWER);
  expect(contents).not.toContain("Find the archive record.");
  expect(contents).not.toContain("runtime_execution_history_turn_v1");
  expect(contents).not.toContain("assistantResponse");
  const source = runtimeCapsule(messages, "runtime_request_source_v1")!;
  const toolReference = runtimeCapsule(messages, "runtime_execution_history_reference_v1");
  if (compacted) {
    expect(contents).toContain(SUMMARY);
    expect(contents).not.toContain(EXECUTION_TOOL_OBSERVATION_KIND);
    expect(contents).not.toContain("old-lookup");
    expect(toolReference).toBeUndefined();
    expect(contents).not.toContain(INTERVENING_QUESTION);
    expect(contents).not.toContain(INTERVENING_ANSWER);
    expect(source).not.toHaveProperty("precedingTurn");
  } else {
    expect(toolReference).toMatchObject({
      authority: "prior_conversation", currentRequestId: "controls-evidence-test",
      observations: [{ messageId: "lookup-assistant", requestId: "lookup-request", results: [{
        executionId: "old-lookup", capabilityId: "source.lookup", outcome: "succeeded", referenceData: DETAIL,
      }] }],
    });
    expect(source.precedingTurn).toEqual({
      user: { id: "other-user", requestId: "other-request", content: INTERVENING_QUESTION },
      assistant: { id: "other-assistant", requestId: "other-request", content: INTERVENING_ANSWER },
    });
    expect(contents.split(INTERVENING_QUESTION)).toHaveLength(2);
    expect(contents.split(INTERVENING_ANSWER)).toHaveLength(2);
    expect(contents).not.toContain(SUMMARY);
  }
}
