import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { projectInvalidOutputProgress } from "../request/root-invalid-output-progress.js";
import {
  createModelWorkPlanEventFixture,
  EVENT_WORK_PLAN,
} from "./support/model-work-plan-event-fixture.js";
import {
  createRootInvalidOutputRequest,
  createRootInvalidOutputLedger,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([
  [
    "The request could not be completed.",
    "Continue from the recorded progress.",
  ],
  ["לא ניתן היה להשלים את הבקשה.", "אפשר להמשיך מההתקדמות שנשמרה."],
])(
  "invalid root output preserves progress without adding a fixed heading: %s",
  async (failureNotice, nextStep) => {
    const fixture = await createModelWorkPlanEventFixture();
    const sourceResultRef = await fixture.returnSource();
    const adopted = await fixture.update({
      mode: "adopt",
      sourceResultRef,
      definition: EVENT_WORK_PLAN,
      itemUpdates: [
        { itemId: "write", status: "done" },
        { itemId: "verify", status: "blocked" },
      ],
    });
    expect(adopted.ok).toBe(true);
    const before = fixture.ledger.current();
    const plan = before.state.calls[0]!.adoptedWorkPlan;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
      text:
        input.modelStep === "degraded.finalization"
          ? JSON.stringify({
              failureNotice,
              nextStep,
            })
          : "invalid",
      meta: {},
    }));
    const request = createRootInvalidOutputRequest(
      invoke,
      "execution-agent-v1",
      {
        requestId: before.state.requestId,
      },
    );

    const result = await runRootExecutionKernel({
      request,
      ledger: fixture.ledger,
    });

    expect(result.output).toBe(
      [
        failureNotice,
        "- [x] Write release\n- [ ] Verify release\n- [ ] Deliver release",
        nextStep,
      ].join("\n\n"),
    );
    expect(result.output).toContain("- [x] Write release");
    expect(result.output).toContain("- [ ] Verify release");
    expect(result.output).toContain("- [ ] Deliver release");
    expect(result.finalObservation).toBeUndefined();
    expect(result.memoryCandidates).toBeUndefined();
    expect(fixture.ledger.current().state.calls[0]!.adoptedWorkPlan).toEqual(
      plan,
    );
    expect(fixture.ledger.current().state.results).toEqual(
      before.state.results,
    );
    expect(fixture.ledger.current().state.phase).toBe("completed");
    const degraded = invoke.mock.calls.find(
      ([input]) => input.modelStep === "degraded.finalization",
    )![0];
    expect(JSON.stringify(degraded.messages)).not.toContain("Write release");
    expect(JSON.stringify(degraded.messages)).not.toContain("Verify release");
  },
);

test("empty plans do not manufacture progress", async () => {
  const ledger = await createRootInvalidOutputLedger();
  expect(projectInvalidOutputProgress(ledger.current())).toBeNull();
  expect(ledger.current().state.plans).toEqual([]);
});

test("repairs overlong degraded phrasing into model-authored text within the existing ceiling", async () => {
  const ledger = await createRootInvalidOutputLedger();
  const maxResponseChars = ledger.current().policy.limits.maxResponseChars;
  let degradedAttempts = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep !== "degraded.finalization")
      return { text: "invalid", meta: {} };
    degradedAttempts += 1;
    return {
      text: JSON.stringify({
        failureNotice:
          degradedAttempts === 1
            ? "x".repeat(maxResponseChars + 1)
            : "I could not finish this request.",
        nextStep: "Continue from the established state.",
      }),
      meta: {},
    };
  });
  const request = createRootInvalidOutputRequest(invoke);
  const result = await runRootExecutionKernel({ request, ledger });
  expect(result.output).toBe(
    "I could not finish this request.\n\nContinue from the established state.",
  );
  expect(degradedAttempts).toBe(2);
  expect(ledger.current().state.rootResponse).toBe(result.output);
  expect(ledger.current().policy.limits.maxResponseChars).toBe(
    maxResponseChars,
  );
});
