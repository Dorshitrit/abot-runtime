import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

function completionGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function failedProvider() {
  return vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "degraded.finalization")
      return {
        text: JSON.stringify({
          failureNotice: "Unable to finish.",
          nextStep: "Continue in a new request.",
        }),
        meta: {},
      };
    throw new Error("primary_provider_failure");
  });
}

test.each(["ordinary", "scheduled"] as const)(
  "%s SUPER failure closes Stop before terminal persistence starts",
  async (origin) => {
    const harness = await createFailureHarness();
    const controls = new LocalRequestControls(() => {});
    const options =
      origin === "ordinary"
        ? controls.ordinary(
            "failure-request",
            {
              id: "peer",
              callClient: async () => null,
              onClose: () => () => {},
            },
            {},
            "failure-session",
          )
        : controls.scheduled({
            requestId: "failure-request",
            sessionId: "failure-session",
          } as SchedulerRun);
    const persistenceStarted = completionGate();
    const finishPersistence = completionGate();
    harness.append.mockImplementation(async (...args) => {
      if (args[1] === "assistant") {
        persistenceStarted.release();
        await finishPersistence.promise;
      }
      return harness.originalAppend(...args);
    });
    const invoke = failedProvider();
    const result = harness.run(invoke, options);
    try {
      await persistenceStarted.promise;
      expect(controls.cancel("failure-request", "failure-session")).toEqual({
        accepted: false,
        reason: "request_not_active",
      });
      expect(options.abortSignal?.aborted).toBe(false);
      finishPersistence.release();
      await result;
      expect(
        controls.cancel("failure-request", "failure-session").accepted,
      ).toBe(false);
      expect(
        harness.append.mock.calls.filter(([, role]) => role === "assistant"),
      ).toHaveLength(1);
      expect(harness.events.filter(({ type }) => type === "completed")).toEqual(
        [],
      );
      expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
        expect.objectContaining({ error: "primary_provider_failure" }),
      ]);
      expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
        "supervisor.decision",
        "degraded.finalization",
      ]);
    } finally {
      finishPersistence.release();
      await result;
      controls.finish("failure-request");
      controls.stop();
    }
  },
);

test("Stop during failure authoring wins before the terminal claim", async () => {
  const harness = await createFailureHarness();
  const controls = new LocalRequestControls(() => {});
  const options = controls.ordinary(
    "failure-request",
    { id: "peer", callClient: async () => null, onClose: () => () => {} },
    {},
    "failure-session",
  );
  const authoringStarted = completionGate();
  const finishAuthoring = completionGate();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep !== "degraded.finalization")
      throw new Error("primary_provider_failure");
    authoringStarted.release();
    await finishAuthoring.promise;
    return {
      text: JSON.stringify({ failureNotice: "Too late.", nextStep: "Retry." }),
      meta: {},
    };
  });
  const result = harness.run(invoke, options);
  try {
    await authoringStarted.promise;
    expect(controls.cancel("failure-request", "failure-session")).toEqual({
      accepted: true,
    });
    finishAuthoring.release();
    await result;
    const session =
      await harness.sessionStore.getSessionById("failure-session");
    expect(
      session?.messages.filter(({ role }) => role === "assistant"),
    ).toEqual([
      expect.objectContaining({
        content: "I stopped the task at your request.",
      }),
    ]);
    expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
      expect.objectContaining({ error: "request_cancelled" }),
    ]);
    expect(harness.events.filter(({ type }) => type === "completed")).toEqual(
      [],
    );
    expect(
      invoke.mock.calls.filter(
        ([input]) => input.modelStep === "degraded.finalization",
      ),
    ).toHaveLength(1);
  } finally {
    finishAuthoring.release();
    await result;
    controls.finish("failure-request");
    controls.stop();
  }
});

test.each(["invalid_attachment", "session_open", "user_append"] as const)(
  "SUPER %s rejection cannot create an orphan assistant response",
  async (failure) => {
    const harness = await createFailureHarness();
    const invoke = failedProvider();
    if (failure === "session_open")
      vi.spyOn(harness.sessionStore, "getOrCreateSession").mockRejectedValue(
        new Error("session_open_failed"),
      );
    if (failure === "user_append")
      harness.append.mockImplementation(async (...args) => {
        if (args[1] === "user") throw new Error("user_append_failed");
        return harness.originalAppend(...args);
      });
    const input = failure === "invalid_attachment" ? { attachments: {} } : {};
    await harness.run(invoke, {}, input);
    expect(invoke).not.toHaveBeenCalled();
    expect(
      harness.append.mock.calls.filter(([, role]) => role === "assistant"),
    ).toEqual([]);
    const session =
      await harness.sessionStore.getSessionById("failure-session");
    expect(session?.messages).toEqual([]);
    expect(harness.events.filter(({ type }) => type === "completed")).toEqual(
      [],
    );
    expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
      expect.objectContaining({
        error:
          failure === "invalid_attachment"
            ? "attachments_must_be_array"
            : `${failure}_failed`,
      }),
    ]);
  },
);

test("SUPER failure after user admission retains its static terminal explanation", async () => {
  const harness = await createFailureHarness();
  const invoke = failedProvider();
  const attachment = {
    id: "sample",
    kind: "file" as const,
    mimeType: "text/plain",
    storageRef: "sample.txt",
  };
  const attachmentStore: RuntimeAttachmentStore = {
    saveAttachment: vi.fn(),
    validateAttachmentReferences: vi.fn(async (attachments) => attachments),
    resolveAttachment: vi.fn(async () => {
      throw new Error("attachment_hydration_failed");
    }),
    deleteSessionAttachments: vi.fn(),
  };
  await harness.run(invoke, { attachmentStore }, { attachments: [attachment] });
  expect(invoke).not.toHaveBeenCalled();
  const session = await harness.sessionStore.getSessionById("failure-session");
  expect(session?.messages.map(({ role }) => role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(
    harness.append.mock.calls.filter(([, role]) => role === "assistant"),
  ).toHaveLength(1);
  expect(harness.events.filter(({ type }) => type === "failed")).toEqual([
    expect.objectContaining({ error: "attachment_hydration_failed" }),
  ]);
  expect(harness.events.filter(({ type }) => type === "completed")).toEqual([]);
});
