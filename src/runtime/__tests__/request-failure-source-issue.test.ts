import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { attachSourceIssueId, readSourceIssueId } from "../../shared/source-issue.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

test.each((["execution-agent-v1", "supervisor-worker-v1"] as const).flatMap((policy) =>
  [false, true].map((durable) => ({ policy, durable }))))(
  "$policy finalization durable=$durable retains exact cause and never an earlier recovered cause", async ({ policy, durable }) => {
  for (const kind of ["provider", "timeout", "unrelated"] as const) {
    const h = await createFailureHarness(policy);
    const sessions = new SessionService({ sessionsDir: h.runtimeConfig.paths.sessionsDir });
    await sessions.getOrCreateSession("failure-session");
    await sessions.updateSessionTitle("failure-session", "Existing conversation");
    const error = kind === "timeout"
      ? new ModelStepTimeoutError("owned_timeout", "execution.decision")
      : new ModelGatewayInvocationError("http", "fixture_failure");
    if (kind === "provider") attachSourceIssueId(error, "provider-occurrence");
    await h.run(async (input) => {
      if (kind === "unrelated") input.onIssue?.({
        issueId: "earlier-recovered", occurredAt: 100,
        code: "model_reasoning_rejected", outcome: "recovered", operation: "chat",
        profileId: "invalid-output-test", provider: "openai", model: "fixture",
      });
      throw error;
    }, {
      sessionStore: sessions,
      ...(durable ? { durableApprovals: true,
        approvalExecution: { activation: { activationId: "activation", ownerEpoch: "owner" } } } : {}),
    });
    const failures = h.events.filter((event) => event.type === "failed");
    expect(failures).toHaveLength(1);
    const details = failures[0]!.details as Record<string, unknown>;
    if (kind === "unrelated") expect(details).not.toHaveProperty("sourceIssueId");
    else expect(details.sourceIssueId).toBe(readSourceIssueId(error));
    const reopened = new SessionService({ sessionsDir: h.runtimeConfig.paths.sessionsDir });
    const replay = await reopened.getRequestReplayById("failure-request");
    const saved = replay!.events.filter((event) => event.type === "failed");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.details).toEqual(details);
  }
});
