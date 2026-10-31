import { expect, test } from "vitest";
import { createRootCompactionFixture } from "./support/root-compaction-fixture.js";

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "S9: %s applies 120K→32K before delayed history→active admission",
  async (policy) => {
    const high = await createRootCompactionFixture(policy, {
      contextWindowTokens: 120000,
    });
    await high.run();
    expect(high.modelInputs).toHaveLength(1);
    for (let index = 0; index < 2; index++) {
      const short = await createRootCompactionFixture(policy, {
        sessionStore: high.sessionStore,
        profileId: "compaction-small",
        contextWindowTokens: 32000,
        baseInputTokens: 18000,
        noActiveEvidence: true,
      });
      await short.run();
      expect(short.modelInputs).toHaveLength(1);
      expect(
        short.events.find(({ name }) => name === "context.window.snapshot"),
      ).toMatchObject({ contextWindowTokens: 32000 });
    }
    const pressured = await createRootCompactionFixture(policy, {
      sessionStore: high.sessionStore,
      profileId: "compaction-small",
      contextWindowTokens: 32000,
    });
    await pressured.run();
    expect(pressured.counts.map(({ inputTokens }) => inputTokens)).toEqual(pressured.pressureCounts);
    expect(pressured.rootInputs).toHaveLength(1);
    const lifecycle = pressured.events.filter(({ name }) =>
      /^context\.compaction\.(started|completed|failed)$/u.test(name),
    );
    expect(lifecycle.map(({ name }) => name)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ]);
    expect(lifecycle[1]).toMatchObject({
      invocationId: lifecycle[0]!.invocationId,
      profileId: "compaction-small",
      contextWindowTokens: 32000,
      beforeInputTokens: pressured.pressureCounts[0],
      afterInputTokens: 18000,
    });
    expect(
      (await pressured.sessionStore.getSessionById(
        pressured.request.sessionId,
      ))!.sessionMemoryCheckpoint?.coveredMessages,
    ).toHaveLength(4);
    expect(
      pressured.request.contextCompactionStore!.snapshot!().checkpoints,
    ).toHaveLength(1);
  },
);
