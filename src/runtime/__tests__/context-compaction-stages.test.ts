import { describe, expect, test } from "vitest";

import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

describe("finite compaction admission stages", () => {
  test("retains partial history then active, commits in order, and dispatches the measured envelope", async () => {
    const harness = createAdmissionFixture();
    const order: string[] = [];
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    history.commit.mockImplementation(() => {
      order.push("history");
    });
    active.commit.mockImplementation(() => {
      order.push("active");
    });
    const controller = createAdmissionController([history, active]);

    await expect(harness.run(controller)).resolves.toBe("ok");

    expect(order).toEqual(["history", "active"]);
    expect(controller.project).toHaveBeenCalledOnce();
    expect(controller.getStages).toHaveBeenCalledOnce();
    expect(history.prepare).toHaveBeenCalledOnce();
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(active.prepare.mock.calls[0]![0].at(-1)?.content).toBe("history");
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.invoke.mock.calls[0]![0].messages).toEqual(
      harness.countInputTokens.mock.calls[2]![0].messages,
    );
    expect(
      harness.events.filter(([name]) => name.startsWith("context.compaction.")),
    ).toEqual([
      [
        "context.compaction.started",
        expect.objectContaining({
          compactionScope: "session_history",
          beforeInputTokens: 23814,
        }),
      ],
      [
        "context.compaction.completed",
        expect.objectContaining({
          compactionScope: "session_history",
          beforeInputTokens: 23814,
          afterInputTokens: 21000,
          sourceRevision: "history-revision",
          coveredSourceCount: 9,
        }),
      ],
    ]);
  });

  test("stops after sufficient history without preparing or counting active input", async () => {
    const harness = createAdmissionFixture({ counts: [23814, 21000] });
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    await harness.run(createAdmissionController([history, active]));
    expect(history.commit).toHaveBeenCalledOnce();
    expect(active.prepare).not.toHaveBeenCalled();
    expect(active.commit).not.toHaveBeenCalled();
    expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
  });

  test.each([23814, 25000])(
    "discards nonreducing history (%s) and tries active on original messages",
    async (historyCount) => {
      const harness = createAdmissionFixture({
        counts: [23814, historyCount, 21000],
      });
      const history = createAdmissionStage("session_history", "history");
      const active = createAdmissionStage("active_request", "active");
      await harness.run(createAdmissionController([history, active]));
      expect(history.commit).not.toHaveBeenCalled();
      expect(active.prepare).toHaveBeenCalledWith(ADMISSION_MESSAGES);
      expect(active.commit).toHaveBeenCalledOnce();
      expect(harness.events).toContainEqual([
        "context.compaction.completed",
        expect.objectContaining({
          compactionScope: "active_request",
          sourceRevision: 2,
          coveredSourceCount: 5,
        }),
      ]);
    },
  );

  test.each([22400, 22500])(
    "exhausts both scopes above or at threshold (%s) without any commits",
    async (lastCount) => {
      const harness = createAdmissionFixture({
        counts: [23814, 22673, lastCount],
      });
      const stages = [
        createAdmissionStage("session_history", "history"),
        createAdmissionStage("active_request", "active"),
      ];
      await expect(
        harness.run(createAdmissionController(stages)),
      ).rejects.toThrow("context_compaction_projection_not_reduced");
      for (const stage of stages) {
        expect(stage.prepare).toHaveBeenCalledOnce();
        expect(stage.commit).not.toHaveBeenCalled();
      }
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(
        harness.events.filter(([name]) => name === "context.compaction.failed"),
      ).toHaveLength(1);
    },
  );

  test.each([
    ["no_eligible_sources", "context_compaction_sources_empty"],
    ["no_new_sources", "context_compaction_projection_not_reduced"],
  ] as const)(
    "keeps active-only %s classification without regeneration",
    async (reason, issue) => {
      const harness = createAdmissionFixture();
      const active = createAdmissionStage("active_request", "active");
      active.prepare.mockResolvedValue({ kind: "unavailable", reason });
      await expect(
        harness.run(createAdmissionController([active])),
      ).rejects.toThrow(issue);
      expect(active.prepare).toHaveBeenCalledOnce();
      expect(active.commit).not.toHaveBeenCalled();
      expect(harness.countInputTokens).toHaveBeenCalledOnce();
      expect(harness.invoke).not.toHaveBeenCalled();
    },
  );

  test("empty plans fail as exhaustion without invented stages", async () => {
    const harness = createAdmissionFixture();
    await expect(harness.run(createAdmissionController([]))).rejects.toThrow(
      "context_compaction_projection_not_reduced",
    );
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  test.each([22399, 22400, 22401, 26704, 26705])(
    "uses authoritative count %s at strict trigger and fit boundaries",
    async (count) => {
      const harness = createAdmissionFixture({ counts: [count, 21000] });
      const active = createAdmissionStage("active_request", "active");
      await harness.run(createAdmissionController([active]));
      expect(active.prepare).toHaveBeenCalledTimes(count < 22400 ? 0 : 1);
      expect(harness.invoke).toHaveBeenCalledOnce();
    },
  );

  test.each([22400, 22401])(
    "uses ceil for a nonintegral trigger, input %s",
    async (count) => {
      const harness = createAdmissionFixture({
        contextWindowTokens: 32001,
        counts: [count, 21000],
      });
      const active = createAdmissionStage("active_request", "active");
      await harness.run(createAdmissionController([active]));
      expect(active.prepare).toHaveBeenCalledTimes(count === 22400 ? 0 : 1);
    },
  );

  test.each(["profileId", "provider", "model", "contextWindowTokens"] as const)(
    "rejects a mismatched candidate count binding: %s",
    async (field) => {
      const harness = createAdmissionFixture();
      const history = createAdmissionStage("session_history", "history");
      const active = createAdmissionStage("active_request", "active");
      const count = harness.countInputTokens.getMockImplementation()!;
      harness.countInputTokens.mockImplementation(async (...args) => {
        const result = await count(...args);
        if (harness.countInputTokens.mock.calls.length === 1) return result;
        return {
          ...result!,
          [field]: field === "contextWindowTokens" ? 120000 : "different",
        };
      });
      await expect(
        harness.run(createAdmissionController([history, active])),
      ).rejects.toThrow("model_input_token_count_binding_mismatch");
      expect(history.commit).not.toHaveBeenCalled();
      expect(active.prepare).not.toHaveBeenCalled();
      expect(harness.invoke).not.toHaveBeenCalled();
    },
  );

  test.each([
    "provider_failed",
    "context_compaction_source_identity_mismatch",
    "context_compaction_checkpoint_invalid",
  ])("preserves %s without trying another scope", async (issue) => {
    const harness = createAdmissionFixture();
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    history.prepare.mockRejectedValue(new Error(issue));
    await expect(
      harness.run(createAdmissionController([history, active])),
    ).rejects.toThrow(issue);
    expect(active.prepare).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  test("rejects invalid stage plans and candidate scope bindings before committing", async () => {
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    for (const stages of [
      [active, history],
      [history, history],
      [history, active, active],
    ]) {
      const harness = createAdmissionFixture();
      await expect(
        harness.run(createAdmissionController(stages)),
      ).rejects.toThrow("context_compaction_stage_plan_invalid");
      expect(history.prepare).not.toHaveBeenCalled();
      expect(harness.invoke).not.toHaveBeenCalled();
    }
    const harness = createAdmissionFixture();
    active.prepare.mockResolvedValue({
      kind: "prepared",
      preparation: {
        messages: [],
        scopeId: "wrong",
        sourceRevision: 1,
        coveredSourceCount: 1,
        commit: active.commit,
      },
    });
    await expect(
      harness.run(createAdmissionController([active])),
    ).rejects.toThrow("context_compaction_stage_scope_mismatch");
    expect(active.commit).not.toHaveBeenCalled();
  });
});
