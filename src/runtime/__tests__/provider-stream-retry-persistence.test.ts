import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { ProviderStreamDisconnectionError } from "../../model-gateway/protocol/provider-stream-disconnection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { rootRespondOutput } from "./support/root-invalid-output-fixture.js";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

const cases = (["execution-agent-v1", "supervisor-worker-v1"] as const)
  .flatMap((policy) => [false, true].map((exhausted) => ({ policy, exhausted })));

test.each(cases)("$policy retry exhausted=$exhausted retains exactly one settled answer through reload", async ({ policy, exhausted }) => {
  const harness = await createFailureHarness(policy);
  const sessions = new SessionService({ sessionsDir: harness.runtimeConfig.paths.sessionsDir });
  await sessions.getOrCreateSession("failure-session");
  await sessions.updateSessionTitle("failure-session", "Existing conversation");
  const decisionStep = policy === "execution-agent-v1" ? "execution.decision" : "supervisor.decision";
  let decisionCalls = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
    if (input.modelStep !== decisionStep) return { text: "The recovered answer.", meta: {} };
    decisionCalls += 1;
    if (exhausted || decisionCalls === 1) throw new ModelGatewayInvocationError(
      "stream", "model_stream_error: openai function response not completed",
      { cause: new ProviderStreamDisconnectionError() },
    );
    return { text: rootRespondOutput(policy), meta: {} };
  }));
  await harness.run(invoke, {
    sessionStore: sessions, durableApprovals: true,
    approvalExecution: { activation: { activationId: "retry-activation", ownerEpoch: "retry-owner" } },
  });
  expect(decisionCalls).toBe(2);
  expect(invoke.mock.calls.some(([input]) => input.modelStep === "degraded.finalization")).toBe(false);
  const expectedType = exhausted ? "failed" : "completed";
  const terminal = harness.events.filter((event) => event.type === "failed" || event.type === "completed");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]!.type).toBe(expectedType);
  const reopened = new SessionService({ sessionsDir: harness.runtimeConfig.paths.sessionsDir });
  const replay = await reopened.getRequestReplayById("failure-request");
  expect(replay!.lifecycle?.status).toBe(expectedType);
  expect(replay!.events.filter((event) => event.type === "failed" || event.type === "completed")).toEqual(terminal);
  const session = await reopened.getSessionById("failure-session");
  const replies = session!.messages.filter((message) => message.role === "assistant" && message.requestId === "failure-request");
  expect(replies).toHaveLength(1);
  expect(replies[0]!.content).toBe(exhausted
    ? "The model service stopped before the response was complete. Try again."
    : "The recovered answer.");
});
