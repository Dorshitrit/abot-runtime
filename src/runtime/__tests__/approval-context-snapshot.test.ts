import { describe, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import {
  captureRequestSessionMemory,
  restoreRequestSessionMemory,
} from "../context/session-memory/snapshot.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import { createModelInvocationIdentity } from "../model/invocation-identity.js";

function session(): SessionRecord {
  const messages = Array.from({ length: 12 }, (_, index) => [
    {
      id: `user-${index}`,
      role: "user" as const,
      content: `Original user ${index}`,
      requestId: `request-${index}`,
      createdAt: "2026-09-28T00:00:00.000Z",
    },
    {
      id: `assistant-${index}`,
      role: "assistant" as const,
      content: `Settled answer ${index}`,
      requestId: `request-${index}`,
      createdAt: "2026-09-28T00:00:01.000Z",
    },
  ]).flat();
  return {
    id: "memory-session",
    title: "Original history",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:01.000Z",
    lastAgentMode: "reasoning",
    messageCount: messages.length,
    messages,
  };
}

describe("context persistence at approval wait", () => {
  test("restores the captured history and compacted prefix without a new model call", async () => {
    const compact = vi.fn(async () => "The first two turns.");
    const repository = {
      compareAndSwapSessionMemoryCheckpoint: vi.fn(
        async (_sessionId, command) => ({
          committed: true as const,
          checkpoint: command.checkpoint,
        }),
      ),
    };
    const memory = createRequestSessionMemory({
      sessionId: "memory-session",
      session: session(),
      compactor: { compact },
      repository,
    });
    const prepared = await memory.prepare(
      {} as BoundRequestModelInvocationContext,
    );
    await prepared.commit();
    const before = memory.project();
    const snapshot = JSON.parse(
      JSON.stringify(captureRequestSessionMemory(memory)),
    );
    const restored = restoreRequestSessionMemory(snapshot, {
      sessionId: "memory-session",
      compactor: { compact },
      repository,
    });
    expect(restored.project()).toEqual(before);
    expect(compact).toHaveBeenCalledOnce();
    expect(
      repository.compareAndSwapSessionMemoryCheckpoint,
    ).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveProperty("session");
    snapshot.source.historyMessages[0].content = "different user intent";
    expect(() =>
      restoreRequestSessionMemory(snapshot, {
        sessionId: "memory-session",
        compactor: { compact },
        repository,
      }),
    ).toThrow("source_invalid");
  });

  test("restores source evidence required by a later reviewer and rejects missing evidence", () => {
    const store = createRequestContextCompactionStore();
    const source = {
      sourceRef: "execution-1",
      content: "Exact unsummarized evidence.",
      sourceFingerprint: createSemanticCompactionSha256Fingerprint(
        "Exact unsummarized evidence.",
      ),
    };
    store.registerSources([source]);
    store.commit({
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId: "worker:call-2",
      requestId: "request-1",
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint("Original request"),
      roleId: "worker",
      callId: "call-2",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint("Bounded task"),
      contextLane: "role_continuation",
      allowedConsumers: ["worker.decision"],
      sourceRevision: 1,
      sourceDigests: [
        {
          sourceRef: source.sourceRef,
          sourceFingerprint: source.sourceFingerprint,
          digest: "Evidence digest.",
        },
      ],
      continuation: {
        completed: [],
        currentState: "Awaiting approval.",
        findings: [],
        evidenceRefs: [source.sourceRef],
        artifacts: [],
        decisions: [],
        failedApproaches: [],
        openWork: [],
        blockers: [],
        nextStep: "Complete the bounded task.",
      },
    });
    const snapshot = JSON.parse(
      JSON.stringify(captureRequestContextCompaction(store)),
    );
    const restored = restoreRequestContextCompaction(snapshot);
    expect(restored.get("worker:call-2")).toEqual(store.get("worker:call-2"));
    expect(
      restored.materializeSource(source.sourceRef, source.sourceFingerprint),
    ).toEqual(source);
    expect(restored.findByCallIds(["unrelated-call"])).toEqual([]);
    snapshot.sources = [];
    expect(() => restoreRequestContextCompaction(snapshot)).toThrow(
      "source_missing",
    );
  });

  test("activation identity prevents event collisions while legacy identity stays stable", () => {
    expect(
      createModelInvocationIdentity("request", undefined, "worker.decision", 1),
    ).toBe("request:worker.decision:1");
    expect(
      createModelInvocationIdentity(
        "request",
        "activation-1",
        "worker.decision",
        1,
      ),
    ).not.toBe(
      createModelInvocationIdentity(
        "request",
        "activation-2",
        "worker.decision",
        1,
      ),
    );
  });
});
