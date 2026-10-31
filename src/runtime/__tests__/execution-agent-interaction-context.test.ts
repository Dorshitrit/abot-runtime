import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildSparkProgressInteractionInstructions } from "../context/spark-conversation-policy.js";
import { buildExecutionInteractionInstructions } from "../steps/execution-agent/interaction-prompt.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { buildSupervisorResponseInput } from "../steps/supervisor-response/input.js";
import { createRequestUserInteractions } from "../user-interactions/request-service.js";
import { createRootCompactionFixture } from "./support/root-compaction-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

const RECEIPT_KIND = "runtime_user_interaction_receipts_v1";
const UPDATE_TEXT = "I found the integration boundary; I will now inspect its callers.";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function receipts(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.filter((message) => message.content.includes(RECEIPT_KIND));
}

function optionsFor(fixture: Awaited<ReturnType<typeof createRootCompactionFixture>>) {
  return {
    head: fixture.head, call: fixture.call,
    steeringSnapshot: { version: 0, updates: [] },
    includeAcknowledgement: false, includeTitle: false,
    allowPlanner: true, allowAuditor: true,
  };
}

test("EA receives one passive copy in decision and response, without another active user request", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", { noActiveEvidence: true });
  const events = { event: vi.fn() };
  const userInteractions = createRequestUserInteractions({ requestId: fixture.request.requestId, events });
  const request = deriveTestRequestExecutionScope(fixture.request, { userInteractions });
  const options = optionsFor(fixture);
  const before = buildExecutionAgentInput(request, options);
  expect(before.contract.allowUserInteraction).toBe(true);
  expect(receipts(before.messages)).toEqual([]);
  const originalHistory = structuredClone(request.historyMessages);
  userInteractions.publish({ kind: "message", text: UPDATE_TEXT }, {
    callId: fixture.call.callId, activationCount: fixture.call.activationCount, steeringVersion: 0,
  });

  const decision = buildExecutionAgentInput(request, options);
  const response = buildExecutionAgentResponseInput(request, options);
  for (const input of [decision, response]) {
    expect(receipts(input.messages)).toHaveLength(1);
    expect(input.messages.filter((message) =>
      message.role === "user" && message.content === request.prompt)).toHaveLength(1);
    const receipt = JSON.parse(receipts(input.messages)[0]!.content);
    expect(receipt).toMatchObject({
      kind: RECEIPT_KIND, authority: "assistant_communication", publishedCount: 1,
      entries: [{ text: UPDATE_TEXT, origin: { callId: fixture.call.callId } }],
    });
    expect(input.messages.filter((message) => message.content.includes(UPDATE_TEXT))).toHaveLength(1);
  }
  expect(decision.messages.filter((message) => !message.content.includes(RECEIPT_KIND)))
    .toEqual(before.messages);
  expect(request.historyMessages).toEqual(originalHistory);
  expect(events.event).toHaveBeenCalledTimes(1);
});

test("approval restoration retains the same passive receipt without republishing", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", { noActiveEvidence: true });
  const original = createRequestUserInteractions({
    requestId: fixture.request.requestId, events: { event: vi.fn() },
  });
  original.publish({ kind: "message", text: UPDATE_TEXT }, {
    callId: fixture.call.callId, activationCount: fixture.call.activationCount, steeringVersion: 0,
  });
  const event = vi.fn();
  const restored = createRequestUserInteractions({
    requestId: fixture.request.requestId, events: { event },
    restored: structuredClone(original.snapshot()),
  });
  const request = deriveTestRequestExecutionScope(fixture.request, { userInteractions: restored });
  const input = buildExecutionAgentInput(request, optionsFor(fixture));
  expect(receipts(input.messages)).toEqual([original.projectContext()]);
  expect(event).not.toHaveBeenCalled();
});

test("an empty service adds no receipt; requests without it keep their previous offer", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", { noActiveEvidence: true });
  const original = buildExecutionAgentInput(fixture.request, optionsFor(fixture));
  expect(original.contract.allowUserInteraction).toBe(false);
  const userInteractions = createRequestUserInteractions({
    requestId: fixture.request.requestId, events: { event: vi.fn() },
  });
  const request = deriveTestRequestExecutionScope(fixture.request, { userInteractions });
  expect(receipts(buildExecutionAgentInput(request, optionsFor(fixture)).messages)).toEqual([]);
  expect(receipts(buildExecutionAgentResponseInput(request, optionsFor(fixture)).messages)).toEqual([]);
  expect(userInteractions.snapshot()).toBeUndefined();
});

test.each([undefined, "spark"] as const)("SUPER decision and response inputs ignore the receipt in session kind %s", async (sessionKind) => {
  const fixture = await createRootCompactionFixture("supervisor-worker-v1", { noActiveEvidence: true });
  const userInteractions = createRequestUserInteractions({
    requestId: fixture.request.requestId, events: { event: vi.fn() },
  });
  userInteractions.publish({ kind: "message", text: UPDATE_TEXT }, {
    callId: fixture.call.callId, activationCount: fixture.call.activationCount, steeringVersion: 0,
  });
  const baseline = deriveTestRequestExecutionScope(fixture.request, { sessionKind });
  const request = deriveTestRequestExecutionScope(baseline, { userInteractions });
  const toolResults = { sourceRevision: fixture.head.revision, results: [] };
  const decisionOptions = { toolResults, skillReadHead: fixture.head };
  const responseOptions = {
    toolResults,
    call: {
      rootCallId: fixture.call.callId, callId: fixture.call.callId,
      parentCallId: fixture.call.parentCallId, depth: fixture.call.depth,
      invocationAttempt: fixture.call.activationCount,
    },
  };
  expect(buildSupervisorDecisionInput(request, decisionOptions))
    .toEqual(buildSupervisorDecisionInput(baseline, decisionOptions));
  expect(buildSupervisorResponseInput(request, responseOptions))
    .toEqual(buildSupervisorResponseInput(baseline, responseOptions));
});

test("SPARK EA receives extra conversational encouragement only when message interactions are supported", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", { noActiveEvidence: true });
  const userInteractions = createRequestUserInteractions({
    requestId: fixture.request.requestId, events: { event: vi.fn() },
  });
  const ordinaryRequest = deriveTestRequestExecutionScope(fixture.request, { userInteractions });
  const sparkRequest = deriveTestRequestExecutionScope(ordinaryRequest, { sessionKind: "spark" });
  const unsupportedSparkRequest = deriveTestRequestExecutionScope(fixture.request, { sessionKind: "spark" });
  const options = optionsFor(fixture);
  const ordinary = buildExecutionAgentInput(ordinaryRequest, options);
  const spark = buildExecutionAgentInput(sparkRequest, options);
  const unsupportedSpark = buildExecutionAgentInput(unsupportedSparkRequest, options);
  const response = buildExecutionAgentResponseInput(sparkRequest, options);
  const extraGuidance = buildSparkProgressInteractionInstructions("spark", true).join("\n");
  const genericGuidance = buildExecutionInteractionInstructions(true).join("\n");
  expect(extraGuidance.length).toBeGreaterThan(0);
  expect(spark.messages[0]!.content.split(extraGuidance)).toHaveLength(2);
  expect(spark.messages[0]!.content.split(genericGuidance)).toHaveLength(2);
  expect(ordinary.messages[0]!.content.split(genericGuidance)).toHaveLength(2);
  for (const input of [ordinary, unsupportedSpark, response])
    expect(input.messages.some(({ content }) => content.includes(extraGuidance))).toBe(false);
  expect(spark.messages.filter(({ role }) => role !== "system"))
    .toEqual(ordinary.messages.filter(({ role }) => role !== "system"));
  expect(spark.contract.allowUserInteraction).toBe(true);
  expect(unsupportedSpark.contract.allowUserInteraction).toBe(false);
});
