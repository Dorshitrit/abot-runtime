import { afterEach, beforeEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import {
  executionControlsLifecycleFixture,
  CONTROLS_APPROVAL_FINGERPRINT,
} from "./support/execution-controls-lifecycle-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("C14/C20: ASK persists only the prepared action and resumes without authoring controls again", async () => {
  const fixture = executionControlsLifecycleFixture({ approval: true });
  const waiting = await runRequestRunner(fixture.makeRequest(), {
    durableApproval: true,
  });
  if (waiting.kind !== "awaiting_approval")
    throw new Error("expected_controls_approval");
  expect(fixture.performed).not.toHaveBeenCalled();
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(
    fixture.calls.filter(({ step }) => step === "capability.controls"),
  ).toHaveLength(1);
  const persisted = JSON.parse(JSON.stringify(waiting.continuation));
  expect(JSON.stringify(persisted)).not.toContain(
    "controlsEvidenceExecutionIds",
  );
  expect(JSON.stringify(persisted)).toContain("chosen/report.txt");
  const resumed = await runRequestRunner(fixture.makeRequest(), {
    durableApproval: true,
    continuation: persisted,
    decisions: [
      {
        approvalId: "controls-exact-approval",
        actionFingerprint: CONTROLS_APPROVAL_FINGERPRINT,
        decision: { approved: true },
      },
    ],
  });
  expect(resumed).toMatchObject({
    kind: "completed",
    result: { output: "The request settled." },
  });
  expect(fixture.restore).toHaveBeenCalledOnce();
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(
    fixture.calls.filter(({ step }) => step === "capability.controls"),
  ).toHaveLength(1);
  expect(fixture.performed).toHaveBeenCalledExactlyOnceWith(
    "capability-execution-1",
    { target: "chosen/report.txt" },
  );
});

test.each(["count", "admission", "compaction", "refinement"] as const)(
  "C15: steering during %s returns to EA without executing the superseded operation",
  async (boundary) => {
    const fixture = executionControlsLifecycleFixture({ boundary });
    await expect(
      runRequestRunner(fixture.makeRequest()),
    ).resolves.toMatchObject({ output: "The request settled." });
    expect(fixture.steering.snapshot().version).toBe(1);
    expect(fixture.performed).not.toHaveBeenCalled();
    expect(fixture.sourceExecute).toHaveBeenCalledTimes(
      boundary === "compaction" ? 1 : 0,
    );
    const controls = fixture.calls.filter(
      ({ step }) => step === "capability.controls",
    );
    expect(controls).toHaveLength(boundary === "refinement" ? 1 : 0);
    const lastRoot = fixture.calls
      .filter(({ step }) => step === "execution.decision")
      .at(-1)!;
    expect(JSON.stringify(lastRoot.messages)).toContain(
      "Stop this operation and report the change.",
    );
    if (boundary === "compaction") {
      expect(
        fixture.calls.filter(({ step }) => step === "context.compact"),
      ).toHaveLength(1);
      expect(
        fixture.events.some(
          ({ name, data }) =>
            name === "context.compaction.failed" &&
            data?.reason === "steering_superseded",
        ),
      ).toBe(true);
    }
  },
);
