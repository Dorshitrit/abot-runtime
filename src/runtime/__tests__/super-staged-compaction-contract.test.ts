import { expect, test } from "vitest";
import {
  stagedSuperFixture,
  STAGED_FACT,
  STAGED_RAW_MARKER,
} from "./support/super-staged-compaction-fixture.js";

test.each([false, true])(
  "S5–S8: SUPER preserves staged rejection, evidence, compaction and review (Planner=%s)",
  async (throughPlanner) => {
    const fixture = stagedSuperFixture(throughPlanner);
    await expect(fixture.run()).resolves.toMatchObject({ output: STAGED_FACT });
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.execute.mock.calls.map(([input]) => input.controls)).toEqual(
      [{ query: "first-observation" }, { query: "second-observation" }],
    );
    const controls = fixture.calls.filter(
      ({ step }) => step === "capability.controls",
    );
    expect(controls).toHaveLength(3);
    expect(JSON.stringify(controls)).not.toContain(
      "controlsEvidenceExecutionIds",
    );
    expect(JSON.stringify(controls[2]!.messages)).toContain(
      "runtime_semantic_compaction_checkpoint_v2",
    );
    expect(JSON.stringify(controls[2]!.messages)).not.toContain(
      STAGED_RAW_MARKER,
    );
    const compactions = fixture.calls.filter(({ step }) =>
      step.startsWith("super.compact."),
    );
    expect(fixture.calls.some(({ step }) => step === "context.compact")).toBe(
      false,
    );
    const coverage = compactions.filter(
      ({ step }) => step === "super.compact.coverage",
    );
    const content = compactions.filter(
      ({ step }) => step === "super.compact.content",
    );
    expect(coverage.length).toBeGreaterThan(2);
    expect(content).toHaveLength(coverage.length);
    const slices = coverage.map(({ messages }, index) => {
      const capsule = JSON.parse(messages[1]!.content).baseCapsule;
      expect(
        JSON.parse(content[index]!.messages[1]!.content).baseCapsule,
      ).toEqual(capsule);
      return capsule.sourceSlice;
    });
    for (const sourceRef of new Set(slices.map((slice) => slice.sourceRef))) {
      const windows = slices.filter((slice) => slice.sourceRef === sourceRef);
      const source = fixture.request.contextCompactionStore!.materializeSource(
        sourceRef,
        windows[0]!.sourceFingerprint,
      )!;
      expect(windows.map((window) => window.content).join("")).toBe(
        source.content,
      );
      expect(windows[0]!.range.startByte).toBe(0);
      for (let index = 1; index < windows.length; index++)
        expect(windows[index]!.range.startByte).toBe(
          windows[index - 1]!.range.endByteExclusive,
        );
      expect(windows.at(-1)!.range.endByteExclusive).toBe(
        Buffer.byteLength(source.content),
      );
    }
    const checkpoints =
      fixture.request.contextCompactionStore!.snapshot!().checkpoints;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.sourceDigests).toHaveLength(2);
    for (const { digest } of checkpoints[0]!.sourceDigests)
      expect(digest).toContain(STAGED_FACT);
    const result = fixture.calls.find(({ step }) => step === "worker.result")!;
    expect(JSON.stringify(result.messages)).toContain(STAGED_FACT);
    expect(JSON.stringify(result.messages)).not.toContain(STAGED_RAW_MARKER);
    const reviewerIndex = fixture.calls.findIndex(
      ({ step }) => step === "reviewer.decision",
    );
    expect(reviewerIndex).toBeGreaterThan(fixture.calls.indexOf(result));
    expect(JSON.stringify(fixture.calls[reviewerIndex]!.messages)).toContain(
      "report.txt",
    );
    const resumedSupervisor = fixture.calls
      .slice(reviewerIndex + 1)
      .find(({ step }) => step === "supervisor.decision")!;
    expect(JSON.stringify(resumedSupervisor.messages)).toContain(
      "reviewer_verdict_v1",
    );
    const reviewerReceipt = resumedSupervisor.messages
      .filter(({ content }) => content.startsWith("{"))
      .map(({ content }) => JSON.parse(content))
      .find(({ reviewerVerdict }) => reviewerVerdict);
    expect(reviewerReceipt).toMatchObject({
      kind: "runtime_child_result",
      roleId: "reviewer",
      outcome: "completed",
      resultRef: expect.any(String),
      reviewerVerdict: { kind: "reviewer_verdict_v1", verdict: "pass" },
    });
    const plannerCalls = fixture.calls.filter(
      ({ step }) => step === "planner.decision",
    );
    expect(plannerCalls).toHaveLength(throughPlanner ? 2 : 0);
    if (throughPlanner)
      expect(JSON.stringify(plannerCalls[1]!.messages)).toContain(
        "work_result_v1",
      );
    expect(
      fixture.events.filter(
        ({ name }) => name === "context.compaction.completed",
      ),
    ).toHaveLength(2);
  },
);

test("S8: multiple Workers preserve separate evidence through independent SUPER stages and the full Planner review chain", async () => {
  const fixture = stagedSuperFixture(true, {
    twoWorkers: true,
  });
  await expect(fixture.run()).resolves.toMatchObject({ output: STAGED_FACT });
  expect(fixture.execute).toHaveBeenCalledTimes(4);
  expect(fixture.execute.mock.calls.map(([input]) => input.controls)).toEqual([
    { query: "first-observation" },
    { query: "second-observation" },
    { query: "first-observation" },
    { query: "second-observation" },
  ]);
  const checkpoints =
    fixture.request.contextCompactionStore!.snapshot!().checkpoints;
  expect(checkpoints).toHaveLength(2);
  expect(new Set(checkpoints.map(({ callId }) => callId)).size).toBe(2);
  const sourceRefs = checkpoints.flatMap(({ sourceDigests }) =>
    sourceDigests.map(({ sourceRef }) => sourceRef),
  );
  expect(
    sourceRefs.filter((ref) => ref.startsWith("capability-execution-")),
  ).toEqual([
    "capability-execution-1",
    "capability-execution-2",
    "capability-execution-3",
    "capability-execution-4",
  ]);
  const supervisionRefs = sourceRefs.filter((ref) =>
    ref.startsWith("operation-supervision-evidence:"),
  );
  expect(supervisionRefs).toHaveLength(0);
  expect(
    JSON.stringify(
      fixture.calls.filter(({ step }) => step === "worker.result"),
    ),
  ).toContain("embedded_exact_result");
  expect(new Set(sourceRefs).size).toBe(4);
  expect(checkpoints.map(({ sourceDigests }) => sourceDigests.length)).toEqual([
    2, 2,
  ]);
  for (const checkpoint of checkpoints) {
    expect(checkpoint.continuation.currentState).toBe(STAGED_FACT);
    expect(
      checkpoint.sourceDigests.every(({ digest }) =>
        digest.includes(STAGED_FACT),
      ),
    ).toBe(true);
  }
  const compactCalls = fixture.calls.filter(
    ({ step }) => step === "super.compact.continuation",
  );
  expect(compactCalls).toHaveLength(4);
  expect(
    fixture.events.filter(
      ({ name }) => name === "context.compaction.completed",
    ),
  ).toHaveLength(4);
  const plannerCalls = fixture.calls.filter(
    ({ step }) => step === "planner.decision",
  );
  expect(plannerCalls).toHaveLength(3);
  const plannerResult = plannerCalls
    .at(-1)!
    .messages.map(({ content }) => content)
    .join("\n");
  expect(plannerResult).toContain("result-1");
  expect(plannerResult).toContain("result-2");
  const reviewer = fixture.calls.find(
    ({ step }) => step === "reviewer.decision",
  )!;
  expect(JSON.stringify(reviewer.messages)).toContain(STAGED_FACT);
  const afterReview = fixture.calls.slice(fixture.calls.indexOf(reviewer) + 1);
  expect(afterReview.map(({ step }) => step)).toEqual([
    "supervisor.decision",
    "supervisor.response",
  ]);
});
