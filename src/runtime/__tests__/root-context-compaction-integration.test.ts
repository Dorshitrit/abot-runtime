import { expect, test } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import {
  assertSuperCompactionSourceIntegrity,
  assertSuperCompactionCheckpointIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import {
  createRootCompactionFixture,
  ROOT_REQUEST,
  HISTORY_FACT,
  ACTIVE_FACT,
} from "./support/root-compaction-fixture.js";
import {
  RECALL_FACT,
  LATEST_CORRECTION,
} from "./support/root-compaction-evidence.js";

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "D1/D2: %s admits one root decision after real history and active-source replacement",
  async (policy) => {
    const fixture = await createRootCompactionFixture(policy);
    await expect(fixture.run()).resolves.toMatchObject({
      decision: { action: "respond" },
    });
    expect(fixture.counts.map(({ inputTokens }) => inputTokens)).toEqual(fixture.pressureCounts);
    expect(fixture.rootInputs).toHaveLength(1);
    const messages = fixture.rootInputs[0]!;
    expect(() => validateModelGatewayMessages(messages)).not.toThrow();
    expect(
      messages.filter(
        ({ role, content }) => role === "user" && content === ROOT_REQUEST,
      ),
    ).toHaveLength(1);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(HISTORY_FACT);
    const historyIndex = messages.findIndex(({ content }) =>
      content.includes(HISTORY_FACT),
    );
    const correctionIndex = messages.findIndex(({ content }) =>
      content.includes(LATEST_CORRECTION),
    );
    expect(correctionIndex).toBeGreaterThan(historyIndex);
    expect(messages[correctionIndex]!.role).toBe("user");
    expect(serialized).toContain(ACTIVE_FACT);
    expect(serialized).not.toContain("old detail");
    expect(serialized).not.toContain("source detail");
    for (let index = 2; index < 12; index++)
      expect(serialized).toContain(`Protected request ${index}`);
    const stored = (await fixture.sessionStore.getSessionById(
      fixture.request.sessionId,
    ))!;
    expect(stored.messages).toHaveLength(24);
    expect(stored.sessionMemoryCheckpoint?.coveredMessages).toHaveLength(4);
    expect(fixture.sessionMemory.project().historyMessages).toHaveLength(20);
    const active = fixture.request.contextCompactionStore!.snapshot!();
    expect(active.checkpoints).toHaveLength(1);
    expect(active.sources.length).toBeGreaterThan(0);
    expect(active.checkpoints[0]!.currentRequestFingerprint).toBeDefined();
    if (policy === "supervisor-worker-v1") {
      const compactors = fixture.modelInputs.filter(({ step }) => step.startsWith("super.compact."));
      expect(compactors.map(({ step }) => step)).toEqual([
        "super.compact.coverage", "super.compact.content",
        "super.compact.coverage", "super.compact.content", "super.compact.continuation",
      ]);
      const capsules = compactors.map(({ messages }) =>
        JSON.parse(messages.find(({ role }) => role === "user")!.content).baseCapsule,
      );
      expect(capsules[0]).toMatchObject({
        authority: "prior_conversation", currentRequest: "",
        sourceSlice: { sourceRef: "settled-history" },
      });
      expect(capsules[0]).toEqual(capsules[1]);
      expect(capsules[2]).toMatchObject({ authority: "settled_evidence", currentRequest: ROOT_REQUEST });
      expect(capsules[2]).toEqual(capsules[3]);
      expect(capsules[3]).toEqual(capsules[4]);
      expect(fixture.modelInputs.some(({ step }) => step === "context.compact")).toBe(false);
      const integrity = {
        requestId: fixture.request.requestId,
        prompt: ROOT_REQUEST,
        head: fixture.head,
        store: fixture.request.contextCompactionStore!,
      };
      assertSuperCompactionSourceIntegrity(integrity);
      assertSuperCompactionCheckpointIntegrity({
        ...integrity,
        checkpoint: active.checkpoints[0]!,
      });
    }
    const lifecycle = fixture.events.filter(({ name }) =>
      name.startsWith("context.compaction."),
    );
    expect(lifecycle.map(({ name }) => name)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ]);
    expect(lifecycle[1]).toMatchObject({
      compactionScope: "session_history",
      beforeInputTokens: fixture.pressureCounts[0],
      afterInputTokens: 18000,
      coveredSourceCount: 2,
    });
    expect(lifecycle[1]!.invocationId).toBe(lifecycle[0]!.invocationId);
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "D25: %s raw response uses both real stages before its only gateway generation",
  async (policy) => {
    const fixture = await createRootCompactionFixture(policy, {
      response: true,
    });
    await expect(fixture.run()).resolves.toBe(
      "The source observation is available.",
    );
    expect(fixture.counts.map(({ inputTokens }) => inputTokens)).toEqual(fixture.pressureCounts);
    expect(fixture.rootInputs).toHaveLength(1);
    expect(() =>
      validateModelGatewayMessages(fixture.rootInputs[0]!),
    ).not.toThrow();
    const serialized = JSON.stringify(fixture.rootInputs[0]);
    expect(serialized).toContain(ROOT_REQUEST);
    expect(serialized).toContain(HISTORY_FACT);
    expect(serialized).toContain(ACTIVE_FACT);
    expect(
      fixture.request.contextCompactionStore!.snapshot!().checkpoints,
    ).toHaveLength(1);
  },
);

test("D25/D26: native batch and recall remain valid while the explicit target stays current intent", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", {
    batch: true,
    recall: true,
  });
  await fixture.run();
  const before = fixture.counts[0]!.messages;
  const after = fixture.rootInputs[0]!;
  expect(() => validateModelGatewayMessages(before)).not.toThrow();
  expect(() => validateModelGatewayMessages(after)).not.toThrow();
  const batch = before.find(
    (message) =>
      message.role === "assistant" && message.toolCalls?.length === 2,
  );
  expect(batch).toBeDefined();
  expect(before.filter((message) => message.role === "tool")).toHaveLength(3);
  const recall = before.filter(
    (message) =>
      message.role === "tool" && message.toolName === "recall_memory",
  );
  expect(recall).toHaveLength(1);
  expect(recall[0]!.content).toContain(RECALL_FACT);
  expect(
    after.filter(
      ({ role, content }) => role === "user" && content === ROOT_REQUEST,
    ),
  ).toHaveLength(1);
  const checkpoint =
    fixture.request.contextCompactionStore!.snapshot!().checkpoints[0]!;
  expect(
    checkpoint.sourceDigests.some(({ sourceRef }) =>
      sourceRef.includes("capability-execution-1"),
    ),
  ).toBe(true);
  expect(
    checkpoint.sourceDigests.some(({ sourceRef }) =>
      sourceRef.includes("capability-execution-2"),
    ),
  ).toBe(true);
  expect(JSON.stringify(after)).toContain(RECALL_FACT);
  for (const message of before) {
    if (message.role !== "tool") continue;
    expect(
      checkpoint.sourceDigests.map(({ sourceRef }) => sourceRef),
    ).toContain(`tool-result:${message.toolCallId}`);
  }
});

test("D22: completed Planner, Worker, Reviewer handoffs remain canonical through root staged admission", async () => {
  const fixture = await createRootCompactionFixture("supervisor-worker-v1", {
    fullChain: true,
  });
  await fixture.run();
  expect(fixture.head.state.calls.map(({ roleId }) => roleId)).toEqual([
    "supervisor",
    "planner",
    "worker",
    "reviewer",
  ]);
  const results = fixture.head.state.results;
  expect(results.map(({ producerCallId }) => producerCallId)).toEqual([
    "call-3",
    "call-2",
    "call-4",
  ]);
  const reviewer = fixture.head.state.calls.find(
    ({ roleId }) => roleId === "reviewer",
  )!;
  expect(reviewer.dependencyResultRefs).toContain(results[1]!.resultRef);
  const snapshot = fixture.request.contextCompactionStore!.snapshot!();
  const integrity = {
    requestId: fixture.request.requestId,
    prompt: ROOT_REQUEST,
    head: fixture.head,
    store: fixture.request.contextCompactionStore!,
  };
  assertSuperCompactionSourceIntegrity(integrity);
  assertSuperCompactionCheckpointIntegrity({
    ...integrity,
    checkpoint: snapshot.checkpoints[0]!,
  });
  expect(JSON.stringify(fixture.counts[0]!.messages)).toContain(
    "reviewer_verdict_v1",
  );
  expect(JSON.stringify(snapshot.sources)).toContain(results[2]!.resultRef);
  expect(fixture.counts.map(({ inputTokens }) => inputTokens)).toEqual(fixture.pressureCounts);
  expect(fixture.rootInputs).toHaveLength(1);
});
