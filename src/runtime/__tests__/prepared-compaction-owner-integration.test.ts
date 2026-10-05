import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import { runExecutionAgentDecision } from "../steps/execution-agent/run.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  executionCompactionSteeringFixture,
  STEERED_FACT,
  STEERED_RAW,
} from "./support/execution-compaction-steering-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

function historySession(id: string): SessionRecord {
  const messages = Array.from({ length: 12 }, (_, turn) =>
    (["user", "assistant"] as const).map((role, offset) => ({
      id: `${role}-${turn}`,
      role,
      content: `${role} history ${turn}`,
      createdAt: new Date(turn * 2000 + offset * 1000).toISOString(),
      requestId: `old-${turn}`,
    })),
  ).flat();
  return {
    id,
    title: "History admission",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    lastAgentMode: "reasoning",
    messageCount: messages.length,
    messages,
  };
}

test.each([
  {
    withHistory: false,
    historyTokens: 25000,
    finalTokens: 23000,
    admitted: true,
  },
  {
    withHistory: true,
    historyTokens: 25000,
    finalTokens: 23000,
    admitted: true,
  },
  {
    withHistory: true,
    historyTokens: 28000,
    finalTokens: 23000,
    admitted: false,
  },
])(
  "actual EA owners: history=$withHistory, prepared counts=$historyTokens/$finalTokens",
  async ({ withHistory, historyTokens, finalTokens, admitted }) => {
    const f = await executionCompactionSteeringFixture();
    const persisted = vi.fn();
    const memory = createRequestSessionMemory({
      sessionId: f.request.sessionId,
      session: historySession(f.request.sessionId),
      compactor: { compact: async () => "COMPACT_HISTORY_ONLY" },
      repository: {
        async compareAndSwapSessionMemoryCheckpoint(id, command) {
          persisted(id, command);
          return { committed: true, checkpoint: command.checkpoint };
        },
      },
    });
    const request = withHistory
      ? deriveTestRequestExecutionScope(f.request, { sessionMemory: memory })
      : f.request;
    f.countInputTokens.mockImplementation(async (input) => {
      const content = JSON.stringify(input.messages);
      let inputTokens = finalTokens;
      if (content.includes(STEERED_RAW))
        inputTokens = content.includes("COMPACT_HISTORY_ONLY")
          ? historyTokens
          : 28000;
      if (input.modelStep === "context.compact") inputTokens = 1000;
      // Checkpoint validation measures its capsule separately from the full input.
      if (Array.isArray(input.messages) && input.messages.length === 1)
        inputTokens = 1000;
      return {
        inputTokens,
        profileId: "test",
        provider: "openai",
        model: "test",
        contextWindowTokens: 32000,
        source: "provider_input_token_count",
      };
    });
    const decision = runExecutionAgentDecision(request, f.options());
    if (!admitted) {
      await expect(decision).rejects.toThrow(
        "context_compaction_projection_not_reduced",
      );
      expect(persisted).not.toHaveBeenCalled();
      expect(memory.project().compactableTurnCount).toBe(2);
      expect(
        f.invoke.mock.calls.every(
          ([input]) => input.modelStep === "context.compact",
        ),
      ).toBe(true);
      return;
    }
    await expect(decision).resolves.toMatchObject({
      decision: { action: "respond" },
    });
    expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "context.compact",
      "execution.decision",
    ]);
    expect(persisted).toHaveBeenCalledTimes(withHistory ? 1 : 0);
    const messages = JSON.stringify(f.invoke.mock.calls.at(-1)![0].messages);
    expect(messages).toContain(STEERED_FACT);
    expect(messages).not.toContain(STEERED_RAW);
    if (withHistory) {
      expect(memory.project().compactableTurnCount).toBe(0);
      expect(messages).toContain("COMPACT_HISTORY_ONLY");
      expect(messages).not.toContain("user history 0");
      expect(messages).toContain("user history 11");
    }
  },
);
