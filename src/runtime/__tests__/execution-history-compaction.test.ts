import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemorySettledTurn } from "../../sessions/memory/source.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "../../sessions/memory/execution-observation.js";
import {
  BOUND_REQUEST_MODEL_INVOCATION,
  type BoundRequestModelInvocationContext,
} from "../request/contracts.js";
import { createAdmissionFixture } from "./support/compaction-admission-fixture.js";
import { readModelMessages } from "./support/semantic-compaction-model-fixture.js";
import { generateSessionMemorySummary } from "../context/session-memory/compaction/run.js";
import { projectSessionMemoryTurn } from "../context/session-memory/compaction/input.js";
import { foldOversizedExecutionHistoryTurn } from "../context/session-memory/compaction/turn-fold.js";
import type { SemanticCompactionSourceSlice } from "../context/semantic-compaction/chunking.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type SummaryInput = Readonly<{
  previousCheckpoint: string | null;
  settledTurns?: readonly Readonly<{
    userMessages: readonly Readonly<{ messageId: string; content: string }>[];
    assistant: Readonly<{ messageId: string; content: string }>;
  }>[];
  settledTurnFragment?: SemanticCompactionSourceSlice;
}>;

describe("EA history compaction", () => {
  it.each([undefined, "execution_agent"] as const)(
    "includes tool-only facts only in the selected scope (%s)",
    async (scope) => {
      const h = createSummaryFixture(32_000);
      h.invoke.mockResolvedValue({ text: JSON.stringify({ summary: "Settled summary" }), meta: {} });
      const turn = createTurn("Tool-only fact: source count is 734, from read-1.");

      await expect(generateSessionMemorySummary({
        request: h.request, turns: [turn], scope,
      })).resolves.toBe("Settled summary");

      expect(h.invoke).toHaveBeenCalledOnce();
      const input = readSummaryInput(h.invoke.mock.calls[0]![0].messages);
      expect(input.previousCheckpoint).toBeNull();
      expect(input.settledTurns).toHaveLength(1);
      expect(input.settledTurnFragment).toBeUndefined();
      const assistant = input.settledTurns![0]!.assistant;
      expect(assistant.messageId).toBe(turn.assistant.id);
      if (!scope) {
        expect(assistant.content).toBe("I collected the data.");
        expect(JSON.stringify(input)).not.toContain("734");
        return;
      }
      const history = JSON.parse(assistant.content);
      expect(history.assistantResponse).toBe("I collected the data.");
      expect(history.requestId).toBe("request-1");
      expect(history.toolObservation.results).toEqual([
        { executionId: "read-1", output: "Tool-only fact: source count is 734, from read-1." },
      ]);
    },
  );

  it("admits every byte of an oversized EA turn in ordered Unicode-safe fragments", async () => {
    const h = createSummaryFixture(9_000);
    const turn = createTurn("Beginning 🐈 עובדה. ".repeat(2_000) + " Final fact: 734.");
    const fragments: SemanticCompactionSourceSlice[] = [];
    const summaries: (string | null)[] = [];
    h.invoke.mockImplementation(async (params) => {
      const input = readSummaryInput(params.messages);
      expect(input.settledTurns).toBeUndefined();
      expect(input.settledTurnFragment).toBeDefined();
      fragments.push(input.settledTurnFragment!);
      summaries.push(input.previousCheckpoint);
      return { text: JSON.stringify({ summary: `Folded ${fragments.length}` }), meta: {} };
    });

    const onProgress = vi.fn();
    const summary = await generateSessionMemorySummary({
      request: h.request, turns: [turn], scope: "execution_agent", previousSummary: "Earlier settled fact", onProgress,
    });

    expect(onProgress.mock.calls[0]![0]).toMatchObject({ unit: "turns", completedUnits: 0, totalUnits: 1 });
    expect(onProgress.mock.lastCall![0]).toMatchObject({ completedUnits: 1, totalUnits: 1 });
    expect(onProgress.mock.calls.some(([p]) => p.totalBytes > 0 && p.completedBytes === p.totalBytes)).toBe(true);
    expect(fragments.length).toBeGreaterThan(1);
    expect(summary).toBe(`Folded ${fragments.length}`);
    expect(summaries).toEqual([
      "Earlier settled fact",
      ...fragments.slice(1).map((_, index) => `Folded ${index + 1}`),
    ]);
    const source = JSON.stringify(projectSessionMemoryTurn(turn, "execution_agent"));
    expect(fragments.map(({ content }) => content).join("")).toBe(source);
    let endByte = 0;
    for (const fragment of fragments) {
      expect(fragment.sourceRef).toBe("session-turn:request-1:assistant-1");
      expect(fragment.sourceFingerprint).toBe(createSemanticCompactionSha256Fingerprint(source));
      expect(fragment.sliceFingerprint).toBe(createSemanticCompactionSha256Fingerprint(fragment.content));
      expect(fragment.range.startByte).toBe(endByte);
      expect(Buffer.from(fragment.content, "utf8").toString("utf8")).toBe(fragment.content);
      endByte += Buffer.byteLength(fragment.content, "utf8");
      expect(fragment.range.endByteExclusive).toBe(endByte);
      expect(fragment.range.totalBytes).toBe(Buffer.byteLength(source, "utf8"));
    }
    expect(endByte).toBe(Buffer.byteLength(source, "utf8"));
  });

  it("preserves the ordinary oversized-turn failure without extra model calls", async () => {
    const h = createSummaryFixture(9_000);
    const turn = createTurn("Tool fact");
    const oversized = { ...turn, assistant: { ...turn.assistant, content: "text ".repeat(10_000) } };
    await expect(generateSessionMemorySummary({
      request: h.request, turns: [oversized],
    })).rejects.toThrow("session_memory_compaction_turn_exceeds_budget");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("fails explicitly without consuming a source when no fragment can fit", async () => {
    const invoke = vi.fn(async () => "Should not run");
    await expect(foldOversizedExecutionHistoryTurn({
      turn: createTurn("Exact result"),
      fits: async () => false,
      invoke,
    })).rejects.toThrow("session_memory_compaction_fragment_exceeds_budget");
    expect(invoke).not.toHaveBeenCalled();
  });
});

function createSummaryFixture(contextWindowTokens: number) {
  const h = createAdmissionFixture({ modelStep: "context.compact", contextWindowTokens, estimatorOnly: true });
  const request: BoundRequestModelInvocationContext = {
    ...h.request,
    [BOUND_REQUEST_MODEL_INVOCATION]: true,
    modelSteps: h.invoker,
  };
  return { ...h, request };
}

function createTurn(output: string): SessionMemorySettledTurn {
  return {
    userMessages: [{
      id: "user-1", role: "user", content: "Collect the data.",
      requestId: "request-1", createdAt: "2026-10-27T10:00:00.000Z",
    }],
    assistant: {
      id: "assistant-1", role: "assistant", content: "I collected the data.",
      requestId: "request-1", createdAt: "2026-10-27T10:01:00.000Z",
      observationContent: JSON.stringify({
        kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "request-1",
        results: [{ executionId: "read-1", output }],
      }),
    },
  };
}

function readSummaryInput(messages: unknown): SummaryInput {
  return JSON.parse(readModelMessages(messages).find(({ role }) => role === "user")!.content);
}
