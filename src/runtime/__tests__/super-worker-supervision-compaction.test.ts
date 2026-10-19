import { expectCompactedSupervisionReference } from "./support/compacted-supervision-assertions.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  supervisionStagedFixture,
  STAGED_FACT,
} from "./support/supervision-staged-fixture.js";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("S11/S12/S13: Supervisor-Planner-Worker-Reviewer-Supervisor reuses the same covered evidence through Worker result without widening Controls", async () => {
  const f = supervisionStagedFixture("supervisor-worker-v1");
  await expect(f.run()).resolves.toMatchObject({ output: STAGED_FACT });
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.calls.filter(({ step }) => step === "context.compact")).toHaveLength(
    1,
  );
  const stages: string[] = [];
  for (const call of f.calls) {
    const capsule = call.messages.flatMap(({ content }) => {
      try {
        const p = JSON.parse(content);
        return p.kind === "runtime_operation_supervision_evidence_v1"
          ? [p]
          : [];
      } catch {
        return [];
      }
    })[0];
    if (capsule) {
      stages.push(`${call.step}:${capsule.entries[0].notice.stage}`);
      expect(capsule.entries[0].evidence).toMatchObject({
        kind: "compacted_capability_result_reference",
        acceptedAction: { controls: { query: "same-observation" } },
      });
      expectCompactedSupervisionReference(
        call.messages,
        capsule.entries[0].evidence,
        "capability-execution-2",
        STAGED_FACT,
      );
      expect(
        f.counted.some(
          (counted) =>
            counted.step === call.step &&
            JSON.stringify(counted.messages) === JSON.stringify(call.messages),
        ),
      ).toBe(true);
    }
    if (
      [
        "capability.controls",
        "planner.decision",
        "reviewer.decision",
        "supervisor.decision",
        "supervisor.response",
      ].includes(call.step)
    ) {
      expect(capsule).toBeUndefined();
    }
  }
  expect(stages).toEqual([
    "worker.decision:warning",
    "worker.decision:intervention",
    "worker.result:intervention",
  ]);
  const chain = f.calls
    .map(({ step }) => step)
    .filter(
      (step) => !["context.compact", "capability.controls"].includes(step),
    );
  expect(chain).toEqual([
    "supervisor.decision",
    "supervisor.decision",
    "supervisor.decision",
    "planner.decision",
    "worker.decision",
    "worker.decision",
    "worker.decision",
    "worker.decision",
    "worker.result",
    "planner.decision",
    "supervisor.decision",
    "reviewer.decision",
    "supervisor.decision",
    "supervisor.response",
  ]);
  expect(f.invoke.mock.calls.slice(0, 3).map(([input]) => supervisorFormatName(input))).toEqual([
    "supervisor_presentation", "supervisor_decision", "supervisor_working_directory",
  ]);
  expect(
    f.calls
      .find(({ step }) => step === "reviewer.decision")!
      .messages.map(({ content }) => content)
      .join("\n"),
  ).toContain("report.txt");
});
