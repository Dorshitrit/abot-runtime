import { describe, expect, test, vi } from "vitest";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

describe("admission of already compacted evidence", () => {
  test.each([
    "execution.decision",
    "worker.decision",
    "tool_payload.raw",
  ] as const)(
    "%s admits verified exhausted sources above trigger but within hard input budget",
    async (modelStep) => {
      const pressure = modelStep === "execution.decision"
        ? { contextWindowTokens: 100_000, counts: [91_000] }
        : { counts: [26_704] };
      const harness = createAdmissionFixture({ modelStep, ...pressure });
      const stage = createAdmissionStage("active_request", "unused");
      const proof = vi.fn(() => true);
      await expect(
        harness.run({
          ...createAdmissionController([stage]),
          hasExhaustedVerifiedCompactionSources: proof,
        }),
      ).resolves.toBe("ok");
      expect(proof).toHaveBeenCalledOnce();
      expect(proof).toHaveBeenCalledWith(ADMISSION_MESSAGES);
      expect(stage.prepare).not.toHaveBeenCalled();
      expect(stage.commit).not.toHaveBeenCalled();
      expect(harness.countInputTokens).toHaveBeenCalledOnce();
      expect(harness.invoke).toHaveBeenCalledOnce();
      expect(harness.invoke.mock.calls[0]![0].messages).toEqual(
        ADMISSION_MESSAGES,
      );
      expect(
        harness.events.filter(([name]) =>
          name.startsWith("context.compaction."),
        ),
      ).toEqual([]);
    },
  );

  test("verified reuse never bypasses the hard budget", async () => {
    const harness = createAdmissionFixture({ counts: [26_705] });
    const stage = createAdmissionStage("active_request", "unused");
    stage.prepare.mockResolvedValue({
      kind: "unavailable",
      reason: "no_new_sources",
    });
    const proof = vi.fn(() => true);
    await expect(
      harness.run({
        ...createAdmissionController([stage]),
        hasExhaustedVerifiedCompactionSources: proof,
      }),
    ).rejects.toThrow("context_compaction_projection_not_reduced");
    expect(proof).not.toHaveBeenCalled();
    expect(stage.prepare).toHaveBeenCalledOnce();
    expect(stage.commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(
      harness.events.filter(([name]) => name === "context.compaction.failed"),
    ).toHaveLength(1);
  });

  test.each(["absent", "fresh_source"] as const)(
    "%s proof keeps ordinary compaction and commits its reduction",
    async (kind) => {
      const harness = createAdmissionFixture({ counts: [25_000, 21_000] });
      const stage = createAdmissionStage(
        "active_request",
        "fresh evidence compacted",
      );
      const controller = createAdmissionController([stage]);
      await harness.run({
        ...controller,
        ...(kind === "fresh_source"
          ? { hasExhaustedVerifiedCompactionSources: () => false }
          : {}),
      });
      expect(stage.prepare).toHaveBeenCalledOnce();
      expect(stage.commit).toHaveBeenCalledOnce();
      expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
      expect(harness.invoke).toHaveBeenCalledOnce();
      expect(
        harness.events.filter(
          ([name]) => name === "context.compaction.completed",
        ),
      ).toHaveLength(1);
    },
  );

  test("cancellation at the reuse proof cannot dispatch a provider call", async () => {
    const harness = createAdmissionFixture({ counts: [25_000] });
    const cancelled = new Error("request_cancelled");
    await expect(
      harness.run({
        ...createAdmissionController([]),
        hasExhaustedVerifiedCompactionSources() {
          harness.abort.abort(cancelled);
          return true;
        },
      }),
    ).rejects.toBe(cancelled);
    expect(harness.invoke).not.toHaveBeenCalled();
  });
});
