import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { composeSuperFailureMessage } from "../request/super-failure-message.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import { projectOutputLimitCause } from "../steps/degraded-finalization/output-limit-cause.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import {
  createRootInvalidOutputRequest,
  ROOT_OUTPUT_POLICIES,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";

const privateProviderText = "PRIVATE_PROVIDER_TEXT /private/path";
const phrasing = {
  failureNotice: "The model's output capacity ended before the response finished.",
  nextStep: "Review the selected model and reasoning settings before continuing.",
};
const authoredOutput = `${phrasing.failureNotice}\n\n${phrasing.nextStep}`;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

function incompleteError(modelStep?: ModelStep, reason = "max_output_tokens") {
  return new ModelOutputIncompleteError(
    { outputLength: 0, providerCompletionReason: reason },
    modelStep,
  );
}

function readProblem(input: Parameters<ModelGatewayClient["invoke"]>[0]) {
  const messages = input.messages as ChatMessage[];
  expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
  const content = messages[1]!.content;
  return JSON.parse(content.slice(content.lastIndexOf("\n{"))) as object;
}

describe.each(ROOT_OUTPUT_POLICIES)("$policyId failure delivery", (policy) => {
  test.each(["decision", "response"] as const)(
    "carries only canonical output-budget facts from %s to the persisted answer",
    async (phase) => {
      const harness = await createFailureHarness(policy.policyId);
      const failingStep = phase === "decision" ? policy.decisionStep : policy.responseStep;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        if (input.modelStep === "degraded.finalization") {
          expect(readProblem(input)).toEqual({
            stage: "provider_completion",
            code: "output_incomplete",
            cause: "model_output_limit",
            modelStep: failingStep,
          });
          expect(JSON.stringify(input.messages)).not.toContain(privateProviderText);
          return { text: JSON.stringify(phrasing), meta: {} };
        }
        if (input.modelStep === failingStep) {
          return {
            text: privateProviderText,
            meta: { providerCompletionReason: `length ${privateProviderText}` },
          };
        }
        return { text: rootRespondOutput(policy.policyId), meta: {} };
      });
      await harness.run(invoke);
      const session = await harness.sessionStore.getSessionById("failure-session");
      expect(session?.messages.filter(({ role }) => role === "assistant")).toEqual([
        expect.objectContaining({ content: authoredOutput }),
      ]);
      expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        ...(phase === "response" ? [policy.responseStep] : []),
        "degraded.finalization",
      ]);
      expect(harness.events.filter(({ type }) => type === "completed")).toEqual([
        expect.objectContaining({ output: authoredOutput }),
      ]);
      expect(harness.events.filter(({ type }) => type === "failed")).toEqual([]);
    },
  );
});

test.each([false, true])(
  "SUPER outer output failure preserves its cause when explanation authoring fails: %s",
  async (authoringFails) => {
    const harness = await createFailureHarness();
    const primary = incompleteError("worker.result");
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep !== "degraded.finalization") throw primary;
      expect(readProblem(input)).toEqual({
        stage: "decide",
        code: "output_incomplete",
        cause: "model_output_limit",
        modelStep: "worker.result",
      });
      if (authoringFails) throw new Error("secondary_provider_failure");
      return { text: JSON.stringify(phrasing), meta: {} };
    });
    await harness.run(invoke);
    const expected = authoringFails
      ? buildDegradedFinalizationFallback({
          problem: { stage: "decide", code: "output_incomplete", ...projectOutputLimitCause(primary) },
          progress: null,
        })
      : authoredOutput;
    const session = await harness.sessionStore.getSessionById("failure-session");
    expect(session?.messages.filter(({ role }) => role === "assistant")).toEqual([
      expect.objectContaining({ content: expected }),
    ]);
    expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
      expect.objectContaining({ error: "output_incomplete" }),
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  },
);

test("typed output-limit cause excludes unregistered steps and all raw provider fields", () => {
  const error = incompleteError(privateProviderText as ModelStep);
  error.message = privateProviderText;
  expect(projectOutputLimitCause(error)).toEqual({ cause: "model_output_limit" });
  expect(projectOutputLimitCause(incompleteError(" execution.decision " as ModelStep)))
    .toEqual({ cause: "model_output_limit" });
  expect(projectOutputLimitCause(incompleteError())).toEqual({ cause: "model_output_limit" });
});

test.each([
  ["untyped error", new Error("output_incomplete")],
  ["error text", new Error(`length ${privateProviderText}`)],
  ["spoofed shape", { name: "ModelOutputIncompleteError", providerCompletionReason: "length" }],
  ["unknown completion", incompleteError("execution.decision", "unknown")],
  ["unrelated failure", new Error("request_deadline_exhausted")],
])("does not invent an output-limit cause from %s", (_name, error) => {
  expect(projectOutputLimitCause(error)).toBeUndefined();
});

test("SUPER cause belongs to the primary failure, not later caller data", async () => {
  const primary = new Error("provider_connection_failed");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(readProblem(input)).toEqual({ stage: "decide", code: primary.message });
    return { text: JSON.stringify(phrasing), meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke);
  request.superFailureFinalization!.remember(primary, "decide");
  await request.superFailureFinalization!.explain({
    error: incompleteError("execution.decision"),
    input: {
      problem: { stage: "request_failure", code: "output_incomplete", cause: "model_output_limit" },
      progress: null,
    },
    maxResponseChars: 1000,
  });
  expect(request.superFailureFinalization!.primaryError()).toBe(primary);
  expect(invoke).toHaveBeenCalledOnce();
});

test("output-limit fallback is actionable while retaining canonical recorded progress", async () => {
  const problem = {
    stage: "provider_completion",
    code: "output_incomplete",
    ...projectOutputLimitCause(incompleteError("execution.decision")),
  };
  const output = buildDegradedFinalizationFallback({
    problem,
    progress: {
      planSummary: "Recorded work",
      completed: [{ id: "saved", title: "Saved artifact" }],
      unresolved: [{ id: "verify", title: "Verify artifact", status: "pending" }],
    },
  });
  expect(output).toContain("output-token limit");
  expect(output).toContain("reasoning settings");
  expect(output).toContain("- [x] Saved artifact");
  expect(output).toContain("- [ ] Verify artifact");
  expect(output).not.toContain("terminal state");
  expect(output).not.toContain("retry");
  const message = await composeSuperFailureMessage({
    requestId: "outer-no-cache",
    error: incompleteError("execution.decision"),
    steering: createRequestSteeringInbox({ requestId: "outer-no-cache" }),
  });
  expect(message.content).toBe(buildDegradedFinalizationFallback({ problem, progress: null }));
});
