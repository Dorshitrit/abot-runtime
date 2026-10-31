import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
} from "./support/compaction-admission-fixture.js";

import { createProjectionRepairStage } from "./support/compaction-projection-repair-fixture.js";

afterEach(() => vi.restoreAllMocks());


function compactionEvents(harness: ReturnType<typeof createAdmissionFixture>) {
  return harness.events
    .map(([name]) => name)
    .filter((name) => name.startsWith("context.compaction."));
}

describe("bounded projection repair admission", () => {
  test.each(["execution.decision", "tool_payload.raw"] as const)(
    "%s repairs once from the original envelope and commits only the measured repair",
    async (modelStep) => {
      // Preserve soft-pressure and hard-reserve margins for EA's 90% trigger.
      const offset = modelStep === "execution.decision" ? 64000 : 0;
      const h = createAdmissionFixture({
        modelStep,
        contextWindowTokens: 32000 + offset,
        counts: [23814 + offset, 25000 + offset, 21000 + offset],
      });
      const active = createProjectionRepairStage("active_request");
      await expect(h.run(createAdmissionController([active]))).resolves.toBe(
        "ok",
      );

      expect(active.prepare).toHaveBeenCalledTimes(2);
      expect(
        active.prepare.mock.calls[0]![1]?.projectionRepair,
      ).toBeUndefined();
      expect(active.prepare.mock.calls[1]![0]).toBe(
        active.prepare.mock.calls[0]![0],
      );
      expect(active.prepare.mock.calls[1]![0]).toEqual(ADMISSION_MESSAGES);
      expect(active.prepare.mock.calls[1]![1]?.projectionRepair).toEqual({
        reason: "projection_not_reduced",
        originalInputTokens: 23814 + offset,
        candidateInputTokens: 25000 + offset,
        targetInputTokens: 22399 + offset,
      });
      expect(active.firstCommit).not.toHaveBeenCalled();
      expect(active.repairCommit).toHaveBeenCalledOnce();
      expect(h.countInputTokens).toHaveBeenCalledTimes(3);
      expect(h.invoke).toHaveBeenCalledOnce();
      expect(h.invoke.mock.calls[0]![0].messages).toEqual(
        h.countInputTokens.mock.calls[2]![0].messages,
      );
      expect(compactionEvents(h)).toEqual([
        "context.compaction.started",
        "context.compaction.completed",
      ]);
    },
  );

  test("restarts after optional projection without reintroducing removed context", async () => {
    const h = createAdmissionFixture({ counts: [23814, 23500, 25000, 21000] });
    const active = createProjectionRepairStage("active_request");
    const projected: readonly ChatMessage[] = [ADMISSION_MESSAGES[1]!];
    const projectForCompaction = vi.fn(() => projected);
    await h.run({
      ...createAdmissionController([active]),
      projectForCompaction,
    });
    expect(projectForCompaction).toHaveBeenCalledOnce();
    expect(active.prepare.mock.calls[0]![0]).toBe(projected);
    expect(active.prepare.mock.calls[1]![0]).toBe(projected);
    expect(
      active.prepare.mock.calls[1]![1]?.projectionRepair?.originalInputTokens,
    ).toBe(23500);
    expect(h.countInputTokens).toHaveBeenCalledTimes(4);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).toHaveBeenCalledOnce();
  });

  test("retains provisional history without repeating it and repairs active from its original input", async () => {
    const h = createAdmissionFixture({ counts: [28000, 24000, 25000, 21000] });
    const history = createProjectionRepairStage("session_history");
    const active = createProjectionRepairStage("active_request");
    const order: string[] = [];
    history.firstCommit.mockImplementation(() => {
      order.push("history");
    });
    active.repairCommit.mockImplementation(() => {
      order.push("active");
    });
    await h.run(createAdmissionController([history, active]));

    expect(history.prepare).toHaveBeenCalledOnce();
    expect(active.prepare).toHaveBeenCalledTimes(2);
    expect(history.prepare.mock.calls[0]![0]).toEqual(ADMISSION_MESSAGES);
    expect(history.prepare.mock.calls[0]![1]).toEqual({ onProgress: expect.any(Function) });
    expect(active.prepare.mock.calls[0]![0].at(-1)?.content).toBe(
      "session_history:first",
    );
    expect(active.prepare.mock.calls[1]![0]).toBe(
      active.prepare.mock.calls[0]![0],
    );
    expect(active.prepare.mock.calls[1]![0]).not.toContainEqual({
      role: "system",
      content: "active_request:first",
    });
    expect(active.prepare.mock.calls[1]![1]?.projectionRepair).toEqual({
      reason: "projection_not_reduced",
      originalInputTokens: 24000,
      candidateInputTokens: 25000,
      targetInputTokens: 22399,
    });
    expect(history.firstCommit).toHaveBeenCalledOnce();
    expect(history.repairCommit).not.toHaveBeenCalled();
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(order).toEqual(["history", "active"]);
    expect(h.countInputTokens).toHaveBeenCalledTimes(4);
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(compactionEvents(h)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ]);
  });

  test.each(["supervisor.decision", "worker.decision"] as const)(
    "%s without stage opt-in keeps the existing failure without regeneration",
    async (modelStep) => {
      const h = createAdmissionFixture({ modelStep, counts: [23814, 25000] });
      const active = createProjectionRepairStage("active_request");
      const stage = { ...active, supportsProjectionRepair: undefined };
      await expect(h.run(createAdmissionController([stage]))).rejects.toThrow(
        "context_compaction_projection_not_reduced",
      );
      expect(active.prepare).toHaveBeenCalledOnce();
      expect(h.countInputTokens).toHaveBeenCalledTimes(2);
      expect(active.firstCommit).not.toHaveBeenCalled();
      expect(active.repairCommit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test.each([23814, 25000])(
    "a repair at %s tokens fails without a third cycle",
    async (tokens) => {
      const h = createAdmissionFixture({ counts: [23814, 25000, tokens] });
      const active = createProjectionRepairStage("active_request");
      await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
        "context_compaction_projection_not_reduced",
      );
      expect(active.prepare).toHaveBeenCalledTimes(2);
      expect(h.countInputTokens).toHaveBeenCalledTimes(3);
      expect(active.firstCommit).not.toHaveBeenCalled();
      expect(active.repairCommit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
      expect(compactionEvents(h)).toEqual([
        "context.compaction.started",
        "context.compaction.failed",
      ]);
    },
  );

  test("does not repair a reduced candidate lacking exhaustion proof above the trigger", async () => {
    const h = createAdmissionFixture({ counts: [23814, 23000] });
    const active = createProjectionRepairStage("active_request");
    const prepare = active.prepare.getMockImplementation()!;
    active.prepare.mockImplementation(async (...args) => {
      const outcome = await prepare(...args);
      if (outcome.kind !== "prepared") return outcome;
      return {
        ...outcome,
        preparation: {
          ...outcome.preparation,
          hasExhaustedCompactionSources: false,
        },
      };
    });
    await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
      "context_compaction_projection_not_reduced",
    );
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(h.countInputTokens).toHaveBeenCalledTimes(2);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).not.toHaveBeenCalled();
  });

  test("a reduced repair that still exceeds the hard budget cannot dispatch", async () => {
    const h = createAdmissionFixture({ counts: [28000, 29000, 27000] });
    const active = createProjectionRepairStage("active_request");
    await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
      "context_compaction_projection_not_reduced",
    );
    expect(active.prepare).toHaveBeenCalledTimes(2);
    expect(h.countInputTokens).toHaveBeenCalledTimes(3);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  test.each(["sourceRevision", "coveredSourceCount"] as const)(
    "rejects a repair that changes %s before measuring or committing it",
    async (field) => {
      const h = createAdmissionFixture({ counts: [23814, 25000] });
      const active = createProjectionRepairStage("active_request");
      const prepare = active.prepare.getMockImplementation()!;
      active.prepare.mockImplementation(async (...args) => {
        const outcome = await prepare(...args);
        if (!args[1]?.projectionRepair || outcome.kind !== "prepared")
          return outcome;
        return {
          ...outcome,
          preparation: { ...outcome.preparation, [field]: 99 },
        };
      });
      await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
        "context_compaction_repair_source_binding_changed",
      );
      expect(active.prepare).toHaveBeenCalledTimes(2);
      expect(h.countInputTokens).toHaveBeenCalledTimes(2);
      expect(active.firstCommit).not.toHaveBeenCalled();
      expect(active.repairCommit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test.each([21000, 23000])(
    "does not retry an accepted first candidate at %s tokens",
    async (tokens) => {
      const h = createAdmissionFixture({ counts: [23814, tokens] });
      const active = createProjectionRepairStage("active_request");
      await h.run(createAdmissionController([active]));
      expect(active.prepare).toHaveBeenCalledOnce();
      expect(active.firstCommit).toHaveBeenCalledOnce();
      expect(active.repairCommit).not.toHaveBeenCalled();
      expect(h.countInputTokens).toHaveBeenCalledTimes(2);
      expect(h.invoke).toHaveBeenCalledOnce();
    },
  );

  test("does not retry if a later first-cycle stage already makes the envelope admissible", async () => {
    const h = createAdmissionFixture({ counts: [23814, 25000, 21000] });
    const history = createProjectionRepairStage("session_history");
    const active = createProjectionRepairStage("active_request");
    await h.run(createAdmissionController([history, active]));
    expect(history.prepare).toHaveBeenCalledOnce();
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(history.firstCommit).not.toHaveBeenCalled();
    expect(active.firstCommit).toHaveBeenCalledOnce();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.countInputTokens).toHaveBeenCalledTimes(3);
  });

  test.each(["no_eligible_sources", "no_new_sources"] as const)(
    "does not retry unavailable-only %s",
    async (reason) => {
      const h = createAdmissionFixture({ counts: [23814] });
      const active = createProjectionRepairStage("active_request");
      active.prepare.mockResolvedValue({ kind: "unavailable", reason });
      await expect(
        h.run(createAdmissionController([active])),
      ).rejects.toThrow();
      expect(active.prepare).toHaveBeenCalledOnce();
      expect(h.countInputTokens).toHaveBeenCalledOnce();
      expect(active.repairCommit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test.each([
    "provider_failed",
    "context_compaction_source_identity_conflict",
    "context_compaction_checkpoint_invalid",
  ])("does not retry preparation failure %s", async (issue) => {
    const h = createAdmissionFixture({ counts: [23814] });
    const active = createProjectionRepairStage("active_request");
    const failure = new Error(issue);
    active.prepare.mockRejectedValue(failure);
    await expect(h.run(createAdmissionController([active]))).rejects.toBe(
      failure,
    );
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(h.countInputTokens).toHaveBeenCalledOnce();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  test("does not convert a measurement failure into projection repair", async () => {
    const h = createAdmissionFixture({ counts: [23814] });
    const active = createProjectionRepairStage("active_request");
    const count = h.countInputTokens.getMockImplementation()!;
    const failure = new Error("model_input_token_count_binding_mismatch");
    h.countInputTokens
      .mockImplementationOnce(count)
      .mockRejectedValueOnce(failure);
    await expect(h.run(createAdmissionController([active]))).rejects.toBe(
      failure,
    );
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(h.countInputTokens).toHaveBeenCalledTimes(2);
    expect(active.repairCommit).not.toHaveBeenCalled();
  });

  test("propagates retry preparation failure without further retries", async () => {
    const h = createAdmissionFixture({ counts: [23814, 25000] });
    const active = createProjectionRepairStage("active_request");
    const prepare = active.prepare.getMockImplementation()!;
    const failure = new Error("provider_failed");
    active.prepare
      .mockImplementationOnce(prepare)
      .mockRejectedValueOnce(failure);
    await expect(h.run(createAdmissionController([active]))).rejects.toBe(
      failure,
    );
    expect(active.prepare).toHaveBeenCalledTimes(2);
    expect(h.countInputTokens).toHaveBeenCalledTimes(2);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  test.each(["prepare", "measure"] as const)(
    "cancellation during retry %s prevents commit and dispatch",
    async (boundary) => {
      const h = createAdmissionFixture({ counts: [23814, 25000, 21000] });
      const active = createProjectionRepairStage("active_request");
      const cancellation = new Error("request_cancelled");
      const prepare = active.prepare.getMockImplementation()!;
      active.prepare.mockImplementation(async (...args) => {
        const outcome = await prepare(...args);
        if (boundary === "prepare" && args[1]?.projectionRepair)
          h.abort.abort(cancellation);
        return outcome;
      });
      const count = h.countInputTokens.getMockImplementation()!;
      h.countInputTokens.mockImplementation(async (...args) => {
        const result = await count(...args);
        if (
          boundary === "measure" &&
          h.countInputTokens.mock.calls.length === 3
        )
          h.abort.abort(cancellation);
        return result;
      });
      await expect(h.run(createAdmissionController([active]))).rejects.toBe(
        cancellation,
      );
      expect(active.prepare).toHaveBeenCalledTimes(2);
      expect(h.countInputTokens).toHaveBeenCalledTimes(
        boundary === "prepare" ? 2 : 3,
      );
      expect(active.firstCommit).not.toHaveBeenCalled();
      expect(active.repairCommit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test("finishes repair before returning a steering-superseded bound decision", async () => {
    const h = createAdmissionFixture({
      modelStep: "execution.decision",
      contextWindowTokens: 96000,
      counts: [87814, 89000, 85000],
    });
    const active = createProjectionRepairStage("active_request");
    const prepare = active.prepare.getMockImplementation()!;
    active.prepare.mockImplementation(async (...args) => {
      const outcome = await prepare(...args);
      if (args[1]?.projectionRepair)
        h.steering.append({ steerId: "one", text: "new direction" });
      return outcome;
    });
    await expect(
      h.run(createAdmissionController([active]), 0),
    ).rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
    expect(active.prepare).toHaveBeenCalledTimes(2);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).toHaveBeenCalledOnce();
    expect(h.countInputTokens).toHaveBeenCalledTimes(3);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(compactionEvents(h)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ]);
  });

  test("does not retry after an accepted candidate reaches a failing commit", async () => {
    const h = createAdmissionFixture({ counts: [23814, 21000] });
    const active = createProjectionRepairStage("active_request");
    const failure = new Error("checkpoint_persistence_failed");
    active.firstCommit.mockRejectedValue(failure);
    await expect(h.run(createAdmissionController([active]))).rejects.toBe(
      failure,
    );
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(active.firstCommit).toHaveBeenCalledOnce();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.countInputTokens).toHaveBeenCalledTimes(2);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
