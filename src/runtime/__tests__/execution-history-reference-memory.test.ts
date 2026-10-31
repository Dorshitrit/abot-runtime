import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "../../sessions/memory/execution-observation.js";
import type { SessionMemoryScope } from "../../sessions/memory/contracts.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRequestSessionMemory } from "../context/session-memory/controller.js";
import type { RequestSessionMemory, SessionMemoryCompactor } from "../context/session-memory/contracts.js";
import {
  createExecutionHistoryReferenceCompactionController,
  createExecutionHistoryReferenceMemory,
  hasExecutionHistoryReference,
} from "../context/session-memory/execution-reference-memory.js";
import { captureRequestSessionMemory, restoreRequestSessionMemory } from "../context/session-memory/snapshot.js";
import { replaceSessionMemoryProjection } from "../context/session-memory/message-replacement.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

const CURRENT = "Save the earlier fact into the explicitly selected new target.";
const FACT = "TOOL_ONLY_FACT_731";
const SUMMARY = "The source established the retained compacted fact.";
const consumer = { modelStep: "capability.controls" as const, callId: "controls-current" };
const invocation = {} as BoundRequestModelInvocationContext;
const observation = JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "lookup",
  results: [{ executionId: "capability-execution-1", outcome: "succeeded", referenceData: FACT }] });

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function fixture(content: string | undefined = observation, scope: SessionMemoryScope | null = "execution_agent") {
  const createdAt = "2026-10-27T09:00:00.000Z";
  const messages: SessionMessage[] = [
    { id: "lookup-u", role: "user", content: "ORIGINAL_LOOKUP_PROMPT", requestId: "lookup", createdAt },
    { id: "lookup-a", role: "assistant", content: "ORIGINAL_LOOKUP_ANSWER", requestId: "lookup", createdAt,
      ...(content === undefined ? {} : { observationContent: content }) },
    { id: "other-u", role: "user", content: "Intervening question", requestId: "other", createdAt },
    { id: "other-a", role: "assistant", content: "Intervening answer", requestId: "other", createdAt },
  ];
  const session: SessionRecord = { id: "history-reference", title: "history", createdAt, updatedAt: createdAt,
    lastAgentMode: "reasoning", messageCount: messages.length, messages };
  return memoryFixture(session, scope);
}

function memoryFixture(session: SessionRecord, scope: SessionMemoryScope | null = "execution_agent") {
  const store = createInMemorySessionStore({ initialSessions: [session] });
  const compareAndSwapSessionMemoryCheckpoint = vi.fn(store.compareAndSwapSessionMemoryCheckpoint);
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => SUMMARY);
  const options = { sessionId: session.id, session, repository: { compareAndSwapSessionMemoryCheckpoint }, compactor: { compact } };
  const memory = createRequestSessionMemory({ ...options, ...(scope ? { scope } : {}) });
  return { session, store, compact, compareAndSwapSessionMemoryCheckpoint, options, memory };
}

function reference(memory?: RequestSessionMemory) {
  return createExecutionHistoryReferenceMemory({ requestId: "current", prompt: CURRENT, ...(memory ? { sessionMemory: memory } : {}) }, consumer);
}

function capsules(memory: RequestSessionMemory) {
  return memory.project().priorConversationMessages.map(({ content }) => JSON.parse(content) as Record<string, unknown>);
}

describe("EA consumer historical evidence reference", () => {
  it("keeps all retained observations across an intervening turn without replaying conversation", () => {
    const { memory } = fixture();
    const view = reference(memory)!;
    expect(hasExecutionHistoryReference(memory)).toBe(true);
    expect(view.project().historyMessages).toEqual([]);
    expect(view.project().priorConversationMessages.map(({ role }) => role)).toEqual(["user", "user"]);
    const [source, evidence] = capsules(view);
    expect(source).toMatchObject({ kind: "runtime_request_source_v1", currentRequest: CURRENT,
      precedingTurn: { user: { id: "other-u", content: "Intervening question" }, assistant: { id: "other-a", content: "Intervening answer" } } });
    expect(evidence).toMatchObject({
      kind: "runtime_execution_history_reference_v1", authority: "prior_conversation",
      currentRequestId: "current", consumer,
      observations: [{ messageId: "lookup-a", requestId: "lookup",
        results: [{ executionId: "capability-execution-1", referenceData: FACT }] }],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("ORIGINAL_LOOKUP_PROMPT");
    expect(serialized).not.toContain("ORIGINAL_LOOKUP_ANSWER");
    expect(serialized).not.toContain("Intervening question");
    expect(serialized).not.toContain(CURRENT);
    expect(view.project().compactableTurnCount).toBe(memory.project().compactableTurnCount);
    expect(captureRequestSessionMemory(view)).toEqual(captureRequestSessionMemory(memory));
  });

  it("uses plain source prose for the latest uncovered pair, not the root's observation envelope", () => {
    const initial = fixture();
    const session = { ...initial.session, messages: initial.session.messages.slice(0, 2), messageCount: 2 };
    const { memory } = memoryFixture(session);
    expect(capsules(reference(memory)!)[0]).toMatchObject({
      precedingTurn: { user: { content: "ORIGINAL_LOOKUP_PROMPT" }, assistant: { content: "ORIGINAL_LOOKUP_ANSWER" } },
    });
    expect(JSON.stringify(capsules(reference(memory)!)[0])).not.toContain(FACT);
  });

  it("leaves ordinary, empty, unscoped and inconsistent-scope memories on their original path", () => {
    const ordinary = fixture("");
    const empty = memoryFixture({ ...ordinary.session, messages: [], messageCount: 0 });
    const legacy = fixture(observation, null);
    const scoped = fixture();
    const mismatched: RequestSessionMemory = { ...scoped.memory,
      snapshot: () => ({ ...scoped.memory.snapshot!(), scope: undefined }) };
    for (const memory of [undefined, ordinary.memory, empty.memory, legacy.memory, mismatched]) {
      expect(hasExecutionHistoryReference(memory)).toBe(false);
      expect(reference(memory)).toBeUndefined();
    }
    const active = { project: () => [], getStages: () => [] };
    expect(createExecutionHistoryReferenceCompactionController({ ...invocation, sessionId: "history-reference" }, undefined, active)).toBe(active);
  });

  it.each([
    "{",
    JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "different", results: ["wrong binding"] }),
    JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "lookup", results: [] }),
    JSON.stringify({ kind: "unknown_kind", requestId: "lookup", results: ["unrecognized"] }),
  ])("does not broaden context for malformed or unbound observation %s", (content) => {
    const { memory } = fixture(content);
    expect(hasExecutionHistoryReference(memory)).toBe(false);
    expect(reference(memory)).toBeUndefined();
  });

  it("replaces the whole source/evidence segment with the committed summary without a covered pair duplicate", async () => {
    const { memory, compact } = fixture();
    const view = reference(memory)!;
    const before = view.project();
    const messages = [{ role: "system" as const, content: "Controls policy" }, ...before.priorConversationMessages,
      { role: "user" as const, content: "Accepted immutable assignment" }];
    const prepared = await view.prepare(invocation);
    expect(compact.mock.calls[0]![0].turns).toHaveLength(2);
    expect(JSON.stringify(compact.mock.calls[0]![0].turns)).toContain(FACT);
    expect(view.project()).toEqual(before);
    const replaced = replaceSessionMemoryProjection({ messages, current: before, next: prepared.projection });
    const projected = prepared.projection.priorConversationMessages.map(({ content }) => JSON.parse(content));
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({ kind: "runtime_request_source_v1", authority: "reference_data",
      sourceRef: "request:current", currentRequest: CURRENT });
    expect(projected[1]).toMatchObject({ summary: SUMMARY, authority: "prior_conversation" });
    expect(prepared.projection.priorConversationMessages.map(({ role }) => role)).toEqual(["user", "system"]);
    expect(JSON.stringify(replaced)).not.toContain(FACT);
    expect(JSON.stringify(replaced)).not.toContain("Intervening answer");
    expect(JSON.stringify(replaced)).not.toContain("runtime_execution_history_reference_v1");
    expect(replaced.at(-1)!.content).toBe("Accepted immutable assignment");
    await prepared.commit();
    expect(view.project()).toEqual(prepared.projection);
    expect(view.project().compactableTurnCount).toBe(0);
  });

  it("omits a checkpoint that only covers ordinary conversation", async () => {
    const initial = fixture("");
    const checkpoint = (await initial.memory.prepare(invocation)).checkpoint;
    const extra = fixture().session.messages.slice(0, 2).map((message) => ({ ...message, id: "later-" + message.id }));
    const session = { ...initial.session, messages: [...initial.session.messages, ...extra], messageCount: 6,
      executionSessionMemoryCheckpoint: checkpoint };
    const { memory } = memoryFixture(session);
    const projected = capsules(reference(memory)!);
    expect(projected.map(({ kind }) => kind)).toEqual(["runtime_request_source_v1", "runtime_execution_history_reference_v1"]);
    expect(JSON.stringify(projected)).not.toContain(SUMMARY);
  });

  it("does not compact hidden ordinary turns after historical tool evidence is already summarized", async () => {
    const initial = fixture();
    const checkpoint = (await initial.memory.prepare(invocation)).checkpoint;
    const extra = initial.session.messages.slice(2).map((message) => ({ ...message, id: "later-" + message.id }));
    const { memory } = memoryFixture({ ...initial.session, messages: [...initial.session.messages, ...extra], messageCount: 6,
      executionSessionMemoryCheckpoint: checkpoint });
    expect(memory.project().compactableTurnCount).toBe(1);
    const view = reference(memory)!;
    expect(view.project().compactableTurnCount).toBe(0);
    expect(capsules(view)[0]).toHaveProperty("precedingTurn");
    expect(capsules(view)[1]).toMatchObject({ summary: SUMMARY });
    expect(capsules(view)).toHaveLength(2);
  });

  it("restores the same reference view from the existing approval snapshot", async () => {
    const { memory, options } = fixture();
    await (await reference(memory)!.prepare(invocation)).commit();
    const snapshot = JSON.parse(JSON.stringify(captureRequestSessionMemory(memory)));
    const restored = restoreRequestSessionMemory(snapshot, options);
    expect(reference(restored)!.project()).toEqual(reference(memory)!.project());
    const legacy = fixture(observation, null);
    const restoredLegacy = restoreRequestSessionMemory(captureRequestSessionMemory(legacy.memory), { ...legacy.options, scope: "execution_agent" });
    expect(reference(restoredLegacy)).toBeUndefined();
  });

  it("delegates parallel consumer preparations and commits to the same coordinated memory", async () => {
    const { memory, compact, compareAndSwapSessionMemoryCheckpoint } = fixture();
    const left = reference(memory)!;
    const right = createExecutionHistoryReferenceMemory({ requestId: "current", prompt: CURRENT, sessionMemory: memory },
      { modelStep: "tool_payload.raw", callId: "payload-current" })!;
    const [first, second] = await Promise.all([left.prepare(invocation), right.prepare(invocation)]);
    await Promise.all([first.commit(), second.commit()]);
    expect(compact).toHaveBeenCalledOnce();
    expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledOnce();
    expect(left.project()).toEqual(right.project());
  });

  it.each(["before_stage_capture", "after_stage_capture", "after_refresh"] as const)(
    "refreshes the entire consumer reference segment when a peer commits %s", async (timing) => {
      const { memory, compact, compareAndSwapSessionMemoryCheckpoint } = fixture();
      const request = { ...invocation, sessionId: "history-reference" };
      const active = { project: (messages: readonly import("../../model-gateway/types.js").ChatMessage[]) => [...messages], getStages: () => [] };
      const leftMemory = reference(memory)!;
      const rightMemory = createExecutionHistoryReferenceMemory({ requestId: "current", prompt: CURRENT, sessionMemory: memory },
        { modelStep: "tool_payload.raw", callId: "payload-current" })!;
      const left = createExecutionHistoryReferenceCompactionController(request, leftMemory, active);
      const right = createExecutionHistoryReferenceCompactionController(request, rightMemory, active);
      const envelope = (view: RequestSessionMemory) => [
        { role: "system" as const, content: "Consumer policy" },
        ...view.project().priorConversationMessages,
        { role: "user" as const, content: "Accepted immutable assignment" },
      ];
      const leftInput = left.project(envelope(leftMemory));
      const rightInput = right.project(envelope(rightMemory));
      const peer = await left.getStages()[0]!.prepare(leftInput);
      if (peer.kind !== "prepared") throw new Error("expected_history_preparation");
      if (timing === "before_stage_capture") await peer.preparation.commit();
      const stages = right.getStages();
      if (timing === "after_stage_capture") await peer.preparation.commit();
      let projected = right.projectForCompaction!(rightInput);
      if (timing === "after_refresh") await peer.preparation.commit();
      if (stages.length > 0) {
        const outcome = await stages[0]!.prepare(projected);
        if (outcome.kind !== "prepared") throw new Error("expected_history_preparation");
        projected = outcome.preparation.messages;
        await outcome.preparation.commit();
      }
      expect(projected).toEqual(envelope(rightMemory));
      const sourceMessages = projected.filter(({ content }) => content.includes('"kind":"runtime_request_source_v1"'));
      expect(sourceMessages).toHaveLength(1);
      expect(JSON.parse(sourceMessages[0]!.content)).not.toHaveProperty("precedingTurn");
      expect(JSON.stringify(projected)).toContain(SUMMARY);
      expect(JSON.stringify(projected)).not.toContain("runtime_execution_history_reference_v1");
      expect(JSON.stringify(projected)).not.toContain("Intervening answer");
      expect(projected.at(-1)!.content).toBe("Accepted immutable assignment");
      expect(compact).toHaveBeenCalledOnce();
      expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledOnce();
    },
  );

  it("shares the CAS through two parallel consumer compaction stages", async () => {
    const { memory, compact, compareAndSwapSessionMemoryCheckpoint } = fixture();
    const request = { ...invocation, sessionId: "history-reference" };
    const active = { project: (messages: readonly import("../../model-gateway/types.js").ChatMessage[]) => [...messages], getStages: () => [] };
    const views = [consumer, { modelStep: "tool_payload.raw" as const, callId: "payload-current" }].map((target) =>
      createExecutionHistoryReferenceMemory({ requestId: "current", prompt: CURRENT, sessionMemory: memory }, target)!);
    const prepared = await Promise.all(views.map(async (view) => {
      const controller = createExecutionHistoryReferenceCompactionController(request, view, active);
      const messages = controller.project([...view.project().priorConversationMessages,
        { role: "user", content: "Accepted immutable assignment" }]);
      return controller.getStages()[0]!.prepare(messages);
    }));
    const checkpoints = prepared.map((outcome) => {
      if (outcome.kind !== "prepared") throw new Error("expected_history_preparation");
      return outcome.preparation;
    });
    await Promise.all(checkpoints.map((checkpoint) => checkpoint.commit()));
    for (const checkpoint of checkpoints) {
      expect(checkpoint.messages).toEqual([...views[0]!.project().priorConversationMessages,
        { role: "user", content: "Accepted immutable assignment" }]);
    }
    expect(compact).toHaveBeenCalledOnce();
    expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledOnce();
  });
});
