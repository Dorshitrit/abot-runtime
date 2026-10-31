import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { attachModelGatewayHttpUserMessage } from "../../model-gateway/client/user-message.js";
import { encodeProviderUserError } from "../../model-gateway/protocol/provider-user-error.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestFailureMessage } from "../request/approval-wait/failure.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

function missingModel() {
  const body = encodeProviderUserError({ code: "ollama_model_not_found", endpoint: "http://127.0.0.1:11434", model: "missing:1b" });
  return attachModelGatewayHttpUserMessage(new ModelGatewayInvocationError("http", "bridge_request_failed:404:PRIVATE"), 404, body, true);
}

test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
  "%s exposes the actual provider remedy without a finalization model call",
  async (policy) => {
    const harness = await createFailureHarness(policy);
    const error = missingModel();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => { throw error; });
    await harness.run(invoke);
    expect(invoke.mock.calls.some(([call]) => call.modelStep === "degraded.finalization")).toBe(false);
    const failed = harness.events.find(({ type }) => type === "failed");
    expect(failed?.error).toBe(error.message);
    const details = failed?.details as { stoppedResponse: string };
    expect(details.stoppedResponse).toContain("ollama pull missing:1b");
    expect(details.stoppedResponse).not.toContain("PRIVATE");
    expect(harness.events.some(({ type }) => type === "completed")).toBe(false);
  },
);

test("persisted ordinary failures use the same safe remedy and cancellation retains authority", () => {
  const options = { partialAnswer: "", error: missingModel() };
  expect(createRequestFailureMessage({ ...options, cause: "request_failed" }).content).toContain("ollama pull missing:1b");
  expect(createRequestFailureMessage({ ...options, cause: "request_cancelled" }).content).toBe("I stopped the task at your request.");
  expect(createRequestFailureMessage({ ...options, cause: "request_interrupted" }).content).not.toContain("Ollama");
});
