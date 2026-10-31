import { afterEach, expect, test, vi } from "vitest";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
} from "./support/compaction-admission-fixture.js";
import { createProjectionRepairStage } from "./support/compaction-projection-repair-fixture.js";

afterEach(() => vi.restoreAllMocks());

test("EA repairs a reduced envelope above the hard budget before committing or dispatching", async () => {
  const h = createAdmissionFixture({
    modelStep: "execution.decision",
    counts: [39_545, 28_708, 26_704],
  });
  const active = createProjectionRepairStage("active_request");
  await expect(h.run(createAdmissionController([active]))).resolves.toBe("ok");

  expect(active.prepare).toHaveBeenCalledTimes(2);
  expect(active.prepare.mock.calls[1]![0]).toBe(active.prepare.mock.calls[0]![0]);
  expect(active.prepare.mock.calls[1]![0]).toEqual(ADMISSION_MESSAGES);
  expect(active.prepare.mock.calls[1]![1]?.projectionRepair).toEqual({
    reason: "envelope_exceeds_available_input",
    originalInputTokens: 39_545,
    candidateInputTokens: 28_708,
    targetInputTokens: 26_704,
  });
  expect(active.firstCommit).not.toHaveBeenCalled();
  expect(active.repairCommit).toHaveBeenCalledOnce();
  expect(h.countInputTokens).toHaveBeenCalledTimes(3);
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(h.invoke.mock.calls[0]![0].messages).toEqual(
    h.countInputTokens.mock.calls[2]![0].messages,
  );
  expect(h.events.map(([name]) => name).filter((name) =>
    name.startsWith("context.compaction."),
  )).toEqual(["context.compaction.started", "context.compaction.completed"]);
});

test.each([28_708, 27_000, 39_545, 40_000])(
  "an unsuccessful budget repair at %i tokens never commits, dispatches or starts a third cycle",
  async (repairedTokens) => {
    const h = createAdmissionFixture({
      modelStep: "execution.decision",
      counts: [39_545, 28_708, repairedTokens],
    });
    const active = createProjectionRepairStage("active_request");
    await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
      "context_compaction_projection_not_reduced",
    );
    expect(active.prepare).toHaveBeenCalledTimes(2);
    expect(h.countInputTokens).toHaveBeenCalledTimes(3);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.events.map(([name]) => name).filter((name) =>
      name.startsWith("context.compaction."),
    )).toEqual(["context.compaction.started", "context.compaction.failed"]);
  },
);

test("budget repair retains provisional history and regenerates active evidence from the same input", async () => {
  const h = createAdmissionFixture({
    modelStep: "execution.decision",
    counts: [44_000, 39_545, 28_708, 26_000],
  });
  const history = createProjectionRepairStage("session_history");
  const active = createProjectionRepairStage("active_request");
  const commits: string[] = [];
  history.firstCommit.mockImplementation(() => { commits.push("history"); });
  active.repairCommit.mockImplementation(() => { commits.push("active"); });
  await h.run(createAdmissionController([history, active]));

  expect(history.prepare).toHaveBeenCalledOnce();
  expect(history.repairCommit).not.toHaveBeenCalled();
  expect(active.prepare).toHaveBeenCalledTimes(2);
  expect(active.prepare.mock.calls[1]![0]).toBe(active.prepare.mock.calls[0]![0]);
  expect(active.prepare.mock.calls[1]![0].at(-1)?.content).toBe("session_history:first");
  expect(active.firstCommit).not.toHaveBeenCalled();
  expect(commits).toEqual(["history", "active"]);
  expect(h.countInputTokens).toHaveBeenCalledTimes(4);
});

test.each(["supervisor.decision", "worker.decision"] as const)(
  "%s without repair opt-in preserves the existing hard-budget failure",
  async (modelStep) => {
    const h = createAdmissionFixture({ modelStep, counts: [39_545, 28_708] });
    const active = createProjectionRepairStage("active_request");
    await expect(h.run(createAdmissionController([
      { ...active, supportsProjectionRepair: undefined },
    ]))).rejects.toThrow("context_compaction_projection_not_reduced");
    expect(active.prepare).toHaveBeenCalledOnce();
    expect(h.countInputTokens).toHaveBeenCalledTimes(2);
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(active.repairCommit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

test("an accepted first candidate at the hard limit needs no repair", async () => {
  const h = createAdmissionFixture({
    modelStep: "execution.decision",
    counts: [39_545, 26_704],
  });
  const active = createProjectionRepairStage("active_request");
  await h.run(createAdmissionController([active]));
  expect(active.prepare).toHaveBeenCalledOnce();
  expect(active.firstCommit).toHaveBeenCalledOnce();
  expect(active.repairCommit).not.toHaveBeenCalled();
  expect(h.countInputTokens).toHaveBeenCalledTimes(2);
});

test("cancellation while measuring budget repair prevents both commits and dispatch", async () => {
  const h = createAdmissionFixture({
    modelStep: "execution.decision",
    counts: [39_545, 28_708, 26_000],
  });
  const active = createProjectionRepairStage("active_request");
  const cancellation = new Error("request_cancelled");
  const count = h.countInputTokens.getMockImplementation()!;
  h.countInputTokens.mockImplementation(async (...args) => {
    const result = await count(...args);
    if (h.countInputTokens.mock.calls.length === 3) h.abort.abort(cancellation);
    return result;
  });
  await expect(h.run(createAdmissionController([active]))).rejects.toBe(cancellation);
  expect(active.prepare).toHaveBeenCalledTimes(2);
  expect(active.firstCommit).not.toHaveBeenCalled();
  expect(active.repairCommit).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
