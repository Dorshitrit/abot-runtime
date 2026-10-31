import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { projectInvalidOutputProgress } from "../request/root-invalid-output-progress.js";
import {
  createModelWorkPlanEventFixture,
  EVENT_WORK_PLAN,
} from "./support/model-work-plan-event-fixture.js";
import {
  createRootInvalidOutputRequest,
  createRootInvalidOutputLedger,
  ROOT_OUTPUT_POLICIES,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([
  {
    cause: "known invalid",
    failureNotice: "ABot could not complete the request because the model returned an invalid decision or response.",
    nextStep: "Try again or choose a different model. Any work already performed still needs to be checked.",
  },
  {
    cause: "unknown English",
    failureNotice: "The request could not be completed.",
    nextStep: "Continue from the recorded progress.",
  },
  {
    cause: "unknown Hebrew",
    failureNotice: "לא ניתן היה להשלים את הבקשה.",
    nextStep: "אפשר להמשיך מההתקדמות שנשמרה.",
  },
])(
  "$cause root failure preserves progress without adding a fixed heading",
  async ({ cause, failureNotice, nextStep }) => {
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
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "degraded.finalization")
        return { text: JSON.stringify({ failureNotice, nextStep }), meta: {} };
      if (cause !== "known invalid")
        throw new ModelOutputIncompleteError({
          outputLength: 0, providerCompletionReason: "unknown",
        }, "execution.decision");
      return { text: "invalid", meta: {} };
    });
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
    const degraded = invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    );
    expect(degraded).toHaveLength(cause === "known invalid" ? 0 : 1);
    if (degraded[0]) {
      expect(JSON.stringify(degraded[0][0].messages)).not.toContain("Write release");
      expect(JSON.stringify(degraded[0][0].messages)).not.toContain("Verify release");
    }
  },
);

test("empty plans do not manufacture progress", async () => {
  const ledger = await createRootInvalidOutputLedger();
  expect(projectInvalidOutputProgress(ledger.current())).toBeNull();
  expect(ledger.current().state.plans).toEqual([]);
});

test.each(ROOT_OUTPUT_POLICIES)(
  "$policyId bounds overlong unknown-cause degraded phrasing with its own attempt policy",
  async (policy) => {
    const ledger = await createRootInvalidOutputLedger(policy.policyId);
    const maxResponseChars = ledger.current().policy.limits.maxResponseChars;
    let degradedAttempts = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
      if (input.modelStep !== "degraded.finalization")
        throw new ModelOutputIncompleteError({
          outputLength: 0, providerCompletionReason: "unknown",
        }, policy.decisionStep);
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
    }));
    const request = createRootInvalidOutputRequest(invoke, policy.policyId);
    const result = await runRootExecutionKernel({ request, ledger });
    const superPolicy = policy.policyId === "supervisor-worker-v1";
    expect(result.output).toBe(
      superPolicy
        ? buildDegradedFinalizationFallback({
            problem: {
              code: "output_incomplete",
              stage: "provider_completion",
            },
            progress: null,
          })
        : "I could not finish this request.\n\nContinue from the established state.",
    );
    expect(degradedAttempts).toBe(superPolicy ? 1 : 2);
    expect(ledger.current().state.rootResponse).toBe(result.output);
    expect(ledger.current().policy.limits.maxResponseChars).toBe(
      maxResponseChars,
    );
  },
);
