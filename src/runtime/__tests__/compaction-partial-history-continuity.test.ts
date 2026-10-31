import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { snapshotSessionMemorySource } from "../../sessions/memory/source.js";
import { createRequestCancellationError } from "../request/cancellation.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createRootCompactionFixture,
  type RootCompactionPolicy,
} from "./support/root-compaction-fixture.js";

const directories: string[] = [];
const policies: readonly RootCompactionPolicy[] = [
  "execution-agent-v1",
  "supervisor-worker-v1",
];
const failures = ["stop_after_history_commit", "active_commit_failure"] as const;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe.each(policies)("%s partial history commit continuity", (policy) => {
  test.each(failures)(
    "%s preserves history across store reload and extends only newly eligible turns",
    async (failure) => {
      const { sessionsDir, store, sessionId } = await createSeededFileHistory(policy);
      const abort = new AbortController();
      const primary = failure === "stop_after_history_commit"
        ? createRequestCancellationError()
        : new Error("active_store_fault");
      const activeStore = createRequestContextCompactionStore();
      const activeCommit = vi.fn((checkpoint: Parameters<typeof activeStore.commit>[0]) => {
        if (failure === "active_commit_failure") throw primary;
        activeStore.commit(checkpoint);
      });
      const persistHistory = store.compareAndSwapSessionMemoryCheckpoint.bind(store);
      const historyCommit = vi.spyOn(store, "compareAndSwapSessionMemoryCheckpoint")
        .mockImplementation(async (...args) => {
          const outcome = await persistHistory(...args);
          if (failure === "stop_after_history_commit" && outcome.committed)
            abort.abort(primary);
          return outcome;
        });
      const interrupted = await createRootCompactionFixture(policy, {
        sessionStore: store,
        response: true,
        abortSignal: abort.signal,
        contextCompactionStore: { ...activeStore, commit: activeCommit },
      });

      await expect(interrupted.run()).rejects.toBe(primary);
      expect(interrupted.rootInputs).toEqual([]);
      expect(historyCommit).toHaveBeenCalledOnce();
      expect(activeCommit).toHaveBeenCalledTimes(failure === "active_commit_failure" ? 1 : 0);
      expect(interrupted.events.filter(({ name }) => /^context\.compaction\.(started|completed|failed)$/u.test(name))
        .map(({ name }) => name))
        .toEqual(["context.compaction.started", "context.compaction.failed"]);
      expect(interrupted.events.find(({ name }) => name === "context.compaction.failed"))
        .toMatchObject({
          issueCode: primary.message,
          reason: failure === "stop_after_history_commit" ? "request_aborted" : "semantic_checkpoint_rejected",
        });
      expect(activeStore.snapshot!().checkpoints).toEqual([]);
      expect(activeStore.snapshot!().sources.length).toBeGreaterThan(0);
      const saved = (await store.getSessionById(sessionId))!.sessionMemoryCheckpoint!;
      expect(saved).toMatchObject({ revision: 1 });
      expect(saved.coveredMessages).toHaveLength(4);
      expect(interrupted.sessionMemory.project().checkpointRevision).toBe(saved.revision);

      // A new request owns a fresh signal and active store; this is not a retry
      // of the failed request or a manufactured approval continuation.
      const reopened = createFileSessionStore({ sessionsDir });
      const next = await createRootCompactionFixture(policy, {
        sessionStore: reopened,
        response: true,
        contextWindowTokens: 120000,
        noActiveEvidence: true,
        prompt: "Present the established conversation facts.",
      });
      expect(next.request.requestId).not.toBe(interrupted.request.requestId);
      expect(next.request.abortSignal.aborted).toBe(false);
      await expect(next.run()).resolves.toBeDefined();
      expect(next.modelInputs.map(({ step }) => step)).toEqual([next.rootStep]);
      expect(next.rootInputs).toHaveLength(1);
      expect(historyCheckpoints(next.rootInputs[0]!)).toEqual([
        expect.objectContaining({ checkpointRevision: saved.revision, summary: saved.summary }),
      ]);
      expect(next.request.contextCompactionStore!.snapshot!().checkpoints).toEqual([]);
      expect(next.request.contextCompactionStore!.snapshot!().sources).toEqual([]);
      expect((await reopened.getSessionById(sessionId))!.sessionMemoryCheckpoint).toEqual(saved);
      const coveredIds = new Set(saved.coveredMessages.map(({ messageId }) => messageId));
      expect(next.sessionMemory.project().historyMessages.some(({ id }) => coveredIds.has(id)))
        .toBe(false);

      // New settled history can make one previously protected turn eligible.
      // Its extension must start after the saved prefix, not regenerate it.
      await reopened.appendMessage(sessionId, "user", "A later settled question.", {
        requestId: "later-settled-turn",
      });
      const extendedSession = await reopened.appendMessage(
        sessionId, "assistant", "A later settled answer.",
        { requestId: "later-settled-turn" },
      );
      const source = snapshotSessionMemorySource(extendedSession);
      const expectedNextTurn = source.turns[2]!;
      const expectedNewIds = [
        ...expectedNextTurn.userMessages.map(({ id }) => id),
        expectedNextTurn.assistant.id,
      ];
      const pressured = await createRootCompactionFixture(policy, {
        sessionStore: reopened,
        response: true,
      });
      const count = vi.mocked(pressured.request.modelGatewayClient.countInputTokens!);
      const originalCount = count.getMockImplementation()!;
      count.mockImplementation(async (input) => {
        const measurement = await originalCount(input);
        if (measurement?.inputTokens !== pressured.pressureCounts[1]) return measurement;
        const extendedHistory = historyCheckpoints(input.messages as readonly ChatMessage[])
          .some(({ checkpointRevision }) => checkpointRevision === saved.revision + 1);
        if (!extendedHistory) return measurement;
        // The common fixture treats every history revision equally. This new
        // prefix reduces input but still requires active-evidence compaction.
        return { ...measurement, inputTokens: pressured.pressureCounts[1] - 173 };
      });
      expect(pressured.sessionMemory.project().compactableTurnCount).toBe(1);
      await expect(pressured.run()).resolves.toBeDefined();
      expect(pressured.rootInputs).toHaveLength(1);
      const historySources = readHistoryGenerationSources(pressured.modelInputs);
      expect(historySources.length).toBeGreaterThan(0);
      for (const input of historySources) {
        expect(input.previousSummary ?? input.previousCheckpoint).toBe(saved.summary);
        const suppliedIds = historySourceMessageIds(input);
        expect(suppliedIds).toEqual(expectedNewIds);
        expect(suppliedIds.some((id) => coveredIds.has(id))).toBe(false);
      }
      const extended = (await reopened.getSessionById(sessionId))!.sessionMemoryCheckpoint!;
      expect(extended.revision).toBe(saved.revision + 1);
      expect(extended.coveredMessages.slice(0, saved.coveredMessages.length))
        .toEqual(saved.coveredMessages);
      expect(extended.coveredMessages.slice(saved.coveredMessages.length).map(({ messageId }) => messageId))
        .toEqual(expectedNewIds);
      expect(pressured.sessionMemory.project().compactableTurnCount).toBe(0);
      expect(pressured.events.filter(({ name }) => /^context\.compaction\.(started|completed|failed)$/u.test(name))
        .map(({ name }) => name))
        .toEqual(["context.compaction.started", "context.compaction.completed"]);
      expect(pressured.request.contextCompactionStore!.snapshot!().checkpoints)
        .toEqual([expect.objectContaining({ requestId: pressured.request.requestId })]);
    },
  );
});

async function createSeededFileHistory(policy: RootCompactionPolicy) {
  const seed = await createRootCompactionFixture(policy);
  const session = (await seed.sessionStore.getSessionById(seed.request.sessionId))!;
  const sessionsDir = await mkdtemp(join(tmpdir(), "abot-partial-history-"));
  directories.push(sessionsDir);
  const store = createFileSessionStore({ sessionsDir });
  for (const message of session.messages) {
    await store.appendMessage(session.id, message.role, message.content, {
      requestId: message.requestId,
    });
  }
  return { sessionsDir, store, sessionId: session.id };
}

function historyCheckpoints(
  messages: readonly ChatMessage[],
): { checkpointRevision: number; summary: string }[] {
  return messages.flatMap(({ content }) => {
    try {
      const record = JSON.parse(content) as {
        kind?: string; checkpointRevision: number; summary: string;
      };
      return record.kind === "runtime_session_memory_checkpoint_v1" ? [record] : [];
    } catch {
      return [];
    }
  });
}

type HistoryMessage = { id?: string; messageId?: string };
type HistorySource = {
  kind: string;
  previousSummary?: string;
  previousCheckpoint?: string;
  settledTurns: readonly {
    userMessages: readonly HistoryMessage[];
    assistant: HistoryMessage;
  }[];
};

function readHistoryGenerationSources(
  inputs: readonly { step: string; messages: readonly ChatMessage[] }[],
): HistorySource[] {
  return inputs.flatMap(({ step, messages }) => {
    if (step === "context.compact") {
      const source = JSON.parse(messages.at(-1)!.content) as HistorySource;
      return source.kind === "runtime_session_memory_compaction_input_v1" ? [source] : [];
    }
    if (!step.startsWith("super.compact.")) return [];
    const stage = JSON.parse(messages.find(({ role }) => role === "user")!.content) as {
      baseCapsule: { authority: string; sourceSlice?: { content: string } };
    };
    if (stage.baseCapsule.authority !== "prior_conversation") return [];
    const source = JSON.parse(stage.baseCapsule.sourceSlice!.content) as HistorySource;
    expect(source.kind).toBe("runtime_super_history_source_v1");
    return [source];
  });
}

function historySourceMessageIds(source: HistorySource): string[] {
  return source.settledTurns.flatMap(({ userMessages, assistant }) =>
    [...userMessages, assistant].map((message) => {
      const id = message.id ?? message.messageId;
      expect(id).toEqual(expect.any(String));
      return id!;
    }),
  );
}
