import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { renderKnownDegradedFailure, resolveKnownFailurePhrasing } from "../steps/degraded-finalization/known-failure.js";
import { runModelAuthoredDegradedFinalization } from "../steps/degraded-finalization/model-authored.js";
import { runSuperDegradedFinalization } from "../steps/degraded-finalization/super.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function invalidDirectory() {
  return new StructuredModelInvalidOutputError("invalid_supervisor_decision", "supervisor.decision", {
    validationStage: "domain_parser",
    repairAttempts: 2,
    repeatedInvalidOutput: true,
    issues: [{ code: "supervisor_working_directory_invalid", path: "workingDirectory", message: "PRIVATE_PATH" }],
  });
}

const input = { problem: { stage: "domain_parser", code: "invalid_supervisor_decision" }, progress: null };

test("a verified directory rejection explains the project boundary without inferring an external cause", () => {
  const phrasing = resolveKnownFailurePhrasing(invalidDirectory());
  expect(phrasing?.failureNotice).toContain("working directory");
  expect(phrasing?.nextStep).toContain("Projects");
  expect(JSON.stringify(phrasing)).not.toContain("PRIVATE_PATH");
  expect(JSON.stringify(phrasing)).not.toContain("domain_parser");
});

test("error text alone cannot select a specific cause", () => {
  expect(resolveKnownFailurePhrasing(new Error("supervisor_working_directory_invalid"))).toBeUndefined();
  expect(resolveKnownFailurePhrasing(new Error("invalid_supervisor_decision"))).toBeUndefined();
});

test("both root policies return known failures without invoking the presentation model", async () => {
  for (const policy of ["supervisor-worker-v1", "execution-agent-v1"] as const) {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>();
    const request = createRootInvalidOutputRequest(invoke, policy);
    const error = invalidDirectory();
    const output = request.superFailureFinalization
      ? (await request.superFailureFinalization.explain({ error, input, maxResponseChars: 1000 })).output
      : await runModelAuthoredDegradedFinalization({ request, error, input, maxResponseChars: 1000 });
    expect(output).toContain("working directory");
    expect(output).toContain("Projects");
    expect(invoke).not.toHaveBeenCalled();
  }
});

test("known framing preserves canonical progress and enforces the response limit", () => {
  const params = {
    error: invalidDirectory(),
    input: {
      ...input,
      progress: {
        planSummary: "Recorded work",
        completed: [{ id: "one", title: "First outcome" }],
        unresolved: [{ id: "two", title: "Remaining outcome", status: "pending" }],
      },
    },
    maxResponseChars: 1000,
  };
  const output = renderKnownDegradedFailure(params);
  expect(output).toContain("- [x] First outcome");
  expect(output).toContain("- [ ] Remaining outcome");
  expect(() => renderKnownDegradedFailure({ ...params, maxResponseChars: 10 })).toThrow(params.error);
});

test("known SUPER failures require no model configuration or remaining model budget", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRootInvalidOutputRequest(invoke);
  const result = await runSuperDegradedFinalization({
    request: { ...request, runnerConfig: { ...request.runnerConfig, steps: {} } },
    error: invalidDirectory(), input, maxResponseChars: 1000, steeringVersion: 0,
    readBudgets: () => ({ requestTimeoutMs: 1, requestRemainingMs: 0, inactivityTimeoutMs: 0, inactivityRemainingMs: 0 }),
  });
  expect(result.output).toContain("Projects");
  expect(invoke).not.toHaveBeenCalled();
});
