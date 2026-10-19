import { createFailureHarness } from "./support/super-handler-failure-fixture.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { SessionDeletedError } from "../session/session-lifecycle-store.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { rootRespondOutput } from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

test.each([
  new Error("provider_connection_failed"),
  new ModelGatewayInvocationError(
    "stream",
    "model_stream_error: ollama_stream_error: prediction aborted, token repeat limit reached",
  ),
])(
  "SUPER escaped provider failure persists one explanation and only the original failed outcome: %s",
  async (failure) => {
    const harness = await createFailureHarness();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "degraded.finalization")
        return {
          text: JSON.stringify({
            failureNotice: "Unable to finish.",
            nextStep: "Continue in a new request.",
          }),
          meta: {},
        };
      throw failure;
    });
    await harness.run(invoke);
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "supervisor.decision",
      "degraded.finalization",
    ]);
    expect(
      harness.append.mock.calls.filter(([, role]) => role === "assistant"),
    ).toHaveLength(1);
    const session =
      await harness.sessionStore.getSessionById("failure-session");
    expect(
      session?.messages.filter(({ role }) => role === "assistant"),
    ).toEqual([
      expect.objectContaining({
        content: "Unable to finish.\n\nContinue in a new request.",
        grounding: "conversation",
      }),
    ]);
    expect(harness.events.filter(({ type }) => type === "completed")).toEqual(
      [],
    );
    expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
      expect.objectContaining({ error: failure.message }),
    ]);
  },
);

test("SUPER outer failure uses fallback once when explanation authoring also fails", async () => {
  const harness = await createFailureHarness();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    throw new Error(
      input.modelStep === "degraded.finalization"
        ? "secondary_provider_failure"
        : "primary_provider_failure",
    );
  });
  await harness.run(invoke);
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(1);
  expect(
    harness.append.mock.calls.filter(([, role]) => role === "assistant"),
  ).toEqual([
    expect.arrayContaining([
      buildDegradedFinalizationFallback({
        problem: { stage: "request_failure", code: "primary_provider_failure" },
        progress: null,
      }),
    ]),
  ]);
  expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
    expect.objectContaining({ error: "primary_provider_failure" }),
  ]);
});

test("SUPER ambiguous terminal append failure is not retried", async () => {
  const harness = await createFailureHarness();
  harness.append.mockImplementation(async (...args) => {
    if (args[1] === "assistant") throw new Error("ambiguous_append_failure");
    return harness.originalAppend(...args);
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "degraded.finalization")
      return { text: "invalid", meta: {} };
    throw new Error("primary_provider_failure");
  });
  await expect(harness.run(invoke)).rejects.toThrow("ambiguous_append_failure");
  expect(
    harness.append.mock.calls.filter(([, role]) => role === "assistant"),
  ).toHaveLength(1);
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(1);
  expect(harness.events.filter(({ type }) => type === "completed")).toEqual([]);
});

test("EA escaped provider failure retains its current event-only behavior", async () => {
  const harness = await createFailureHarness("execution-agent-v1");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    throw new Error("provider_connection_failed");
  });
  await harness.run(invoke);
  expect(invoke).toHaveBeenCalledOnce();
  expect(
    harness.append.mock.calls.filter(([, role]) => role === "assistant"),
  ).toEqual([]);
  expect(harness.events.filter(({ type }) => type === "failed")).toHaveLength(
    1,
  );
});

test("SUPER confirmed successful append is not replaced after terminal transport failure", async () => {
  const harness = await createFailureHarness();
  harness.rejectTransport("completed");
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => ({
    text:
      input.modelStep === "supervisor.decision"
        ? rootRespondOutput("supervisor-worker-v1")
        : "Established answer.",
    meta: {},
  })));
  await harness.run(invoke);
  expect(
    harness.append.mock.calls.filter(([, role]) => role === "assistant"),
  ).toHaveLength(1);
  expect(harness.events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(0);
  const session = await harness.sessionStore.getSessionById("failure-session");
  expect(session?.messages.filter(({ role }) => role === "assistant")).toEqual([
    expect.objectContaining({ content: "Established answer." }),
  ]);
});

test("a committed root failure response is still persisted through the outer route after token delivery fails", async () => {
  const harness = await createFailureHarness();
  harness.rejectTransport("token");
  const phrasing = {
    failureNotice: "Unable to finish safely.",
    nextStep: "Continue in a new request.",
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
    text:
      input.modelStep === "degraded.finalization"
        ? JSON.stringify(phrasing)
        : "invalid",
    meta: {},
  }));
  await harness.run(invoke);
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(1);
  const assistantWrites = harness.append.mock.calls.filter(
    ([, role]) => role === "assistant",
  );
  expect(assistantWrites).toHaveLength(1);
  expect(assistantWrites[0]![2]).toBe(
    `${phrasing.failureNotice}\n\n${phrasing.nextStep}`,
  );
  expect(harness.events.filter(({ type }) => type === "completed")).toEqual([]);
  expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
    expect.objectContaining({ error: "invalid_supervisor_decision" }),
  ]);
});

test.each(["failure-session", "different-session"])(
  "SUPER handles only its own confirmed deleted append: %s",
  async (deletedSessionId) => {
    const harness = await createFailureHarness();
    const deleted = new SessionDeletedError(deletedSessionId);
    harness.append.mockImplementation(async (...args) => {
      if (args[1] === "assistant") throw deleted;
      return harness.originalAppend(...args);
    });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => ({
      text:
        input.modelStep === "supervisor.decision"
          ? rootRespondOutput("supervisor-worker-v1")
          : "Established answer.",
      meta: {},
    })));
    if (deletedSessionId === "failure-session") {
      await expect(harness.run(invoke)).resolves.toBeUndefined();
      expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
        expect.objectContaining({ error: deleted.message }),
      ]);
    } else {
      await expect(harness.run(invoke)).rejects.toBe(deleted);
      expect(harness.events.filter(({ type }) => type === "failed")).toEqual(
        [],
      );
    }
    expect(harness.events.filter(({ type }) => type === "completed")).toEqual(
      [],
    );
    expect(
      harness.append.mock.calls.filter(([, role]) => role === "assistant"),
    ).toHaveLength(1);
    expect(
      invoke.mock.calls.some(
        ([input]) => input.modelStep === "degraded.finalization",
      ),
    ).toBe(false);
  },
);

test("SUPER confirmed deletion during failure-message append finishes once without retry", async () => {
  const harness = await createFailureHarness();
  const deleted = new SessionDeletedError("failure-session");
  harness.append.mockImplementation(async (...args) => {
    if (args[1] === "assistant") throw deleted;
    return harness.originalAppend(...args);
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "degraded.finalization")
      return { text: "invalid", meta: {} };
    throw new Error("primary_provider_failure");
  });
  await expect(harness.run(invoke)).resolves.toBeUndefined();
  expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
    expect.objectContaining({ error: deleted.message }),
  ]);
  expect(harness.events.filter(({ type }) => type === "completed")).toEqual([]);
  expect(
    harness.append.mock.calls.filter(([, role]) => role === "assistant"),
  ).toHaveLength(1);
  expect(
    invoke.mock.calls.filter(
      ([input]) => input.modelStep === "degraded.finalization",
    ),
  ).toHaveLength(1);
});
