import { expect, test, vi } from "vitest";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  captureRequestSessionMemory,
  restoreRequestSessionMemory,
} from "../context/session-memory/snapshot.js";
import {
  createRootCompactionFixture,
  HISTORY_FACT,
} from "./support/root-compaction-fixture.js";

test.each([false, true])(
  "D19: lower capacity is effective on the next request (profile changes=%s)",
  async (changeProfile) => {
    const high = await createRootCompactionFixture("execution-agent-v1", {
      contextWindowTokens: 120000,
    });
    await high.run();
    expect(high.modelInputs.map(({ step }) => step)).toEqual([
      "execution.decision",
    ]);
    const profileId = changeProfile ? "compaction-small" : "compaction-test";
    for (let index = 0; index < 2; index++) {
      const short = await createRootCompactionFixture("execution-agent-v1", {
        sessionStore: high.sessionStore,
        profileId,
        contextWindowTokens: 32000,
        baseInputTokens: 18000,
        noActiveEvidence: true,
      });
      await short.run();
      expect(short.modelInputs.map(({ step }) => step)).toEqual([
        "execution.decision",
      ]);
      expect(
        short.events.find(({ name }) => name === "context.window.snapshot"),
      ).toMatchObject({ contextWindowTokens: 32000 });
    }
    const pressured = await createRootCompactionFixture("execution-agent-v1", {
      sessionStore: high.sessionStore,
      profileId,
      contextWindowTokens: 32000,
    });
    await pressured.run();
    expect(pressured.counts.map(({ inputTokens }) => inputTokens)).toEqual([
      23814, 22673, 18000,
    ]);
    expect(
      pressured.events.find(
        ({ name }) => name === "context.compaction.started",
      ),
    ).toMatchObject({ profileId, contextWindowTokens: 32000 });
  },
);

test("D20: increasing capacity preserves committed history without regenerating raw history", async () => {
  const small = await createRootCompactionFixture("execution-agent-v1");
  await small.run();
  const checkpoint = (await small.sessionStore.getSessionById(
    small.request.sessionId,
  ))!.sessionMemoryCheckpoint;
  const large = await createRootCompactionFixture("execution-agent-v1", {
    sessionStore: small.sessionStore,
    contextWindowTokens: 120000,
  });
  await large.run();
  expect(large.modelInputs.map(({ step }) => step)).toEqual([
    "execution.decision",
  ]);
  expect(large.counts.map(({ inputTokens }) => inputTokens)).toEqual([22673]);
  expect(large.sessionMemory.project().historyMessages).toHaveLength(20);
  expect(JSON.stringify(large.rootInputs[0])).toContain(HISTORY_FACT);
  expect(JSON.stringify(large.rootInputs[0])).not.toContain("old detail");
  expect(
    (await large.sessionStore.getSessionById(large.request.sessionId))!
      .sessionMemoryCheckpoint,
  ).toEqual(checkpoint);
});

test("D21: partial finalization snapshot keeps committed history and source inventory without active checkpoint", async () => {
  const store = createRequestContextCompactionStore();
  const commit = vi.fn(() => {
    throw new Error("active_store_fault");
  });
  const fixture = await createRootCompactionFixture("execution-agent-v1", {
    contextCompactionStore: { ...store, commit },
  });
  await expect(fixture.run()).rejects.toThrow("active_store_fault");
  expect(fixture.rootInputs).toEqual([]);
  expect(commit).toHaveBeenCalledOnce();
  const snapshot = JSON.parse(
    JSON.stringify(captureRequestContextCompaction(store)),
  );
  expect(snapshot.checkpoints).toEqual([]);
  expect(snapshot.sources.length).toBeGreaterThan(0);
  expect(snapshot).not.toHaveProperty("invalidatedScopes");
  const restored = restoreRequestContextCompaction(snapshot);
  expect(restored.snapshot!()).toEqual(snapshot);
  const compact = vi.fn();
  const memory = restoreRequestSessionMemory(
    JSON.parse(
      JSON.stringify(captureRequestSessionMemory(fixture.sessionMemory)),
    ),
    {
      sessionId: fixture.request.sessionId,
      repository: fixture.sessionStore,
      compactor: { compact },
    },
  );
  expect(memory.project()).toEqual(fixture.sessionMemory.project());
  expect(memory.project().historyMessages).toHaveLength(20);
  expect(compact).not.toHaveBeenCalled();
  expect(
    fixture.events
      .filter(({ name }) => name.startsWith("context.compaction."))
      .map(({ name }) => name),
  ).toEqual(["context.compaction.started", "context.compaction.failed"]);
});

test("D26: unrelated follow-up keeps its explicit new target as the only current request", async () => {
  const previous = await createRootCompactionFixture("execution-agent-v1");
  await previous.run();
  const prompt = "Explain the word orbit and save nothing.";
  const unrelated = await createRootCompactionFixture("execution-agent-v1", {
    sessionStore: previous.sessionStore,
    contextWindowTokens: 120000,
    prompt,
    noActiveEvidence: true,
  });
  await expect(unrelated.run()).resolves.toMatchObject({
    decision: { action: "respond" },
  });
  const input = unrelated.rootInputs[0]!;
  expect(
    input.filter(({ role, content }) => role === "user" && content === prompt),
  ).toHaveLength(1);
  expect(JSON.stringify(input)).not.toContain(
    "runtime_semantic_compaction_checkpoint_v2",
  );
  expect(JSON.stringify(input)).not.toContain("explicit-new-target.txt");
  expect(unrelated.head.state.capabilityExecutions).toEqual([]);
  expect(unrelated.modelInputs.map(({ step }) => step)).toEqual([
    "execution.decision",
  ]);
});
