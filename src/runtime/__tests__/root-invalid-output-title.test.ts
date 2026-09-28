import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { handleRunRequest } from "../request/handler.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
  INVALID_OUTPUT_MODEL_POLICY,
} from "./support/root-invalid-output-fixture.js";
import {
  createRuntimeConfig,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";

const phrasing = {
  failureNotice: "The final answer failed validation.",
  nextStep: "Continue from the established state.",
};
const degradedResponse = `${phrasing.failureNotice}\n\n${phrasing.nextStep}`;
const title = "Established result";
const respond = (value = title) =>
  JSON.stringify({
    decision: {
      action: "respond",
      acknowledgement: "I will report the result.",
      title: value,
    },
  });

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
  await disposeCompositionFixtures();
});

test.each(["valid", "invalid"] as const)(
  "persists the accepted title before %s response completion",
  async (responseOutcome) => {
    const runtimeConfig = {
      ...(await createRuntimeConfig()),
      plugins: { enabled: false },
      models: INVALID_OUTPUT_MODEL_POLICY,
      modelExecutionPolicies: {
        "invalid-output-test": { policy: "execution-agent-v1" as const },
      },
    };
    await writeFile(
      runtimeConfig.requestRunner.configPath!,
      JSON.stringify({
        schemaVersion: 2,
        models: { defaults: { profileId: "invalid-output-test", steps: {} } },
        context: {
          outputReserveTokens: 1000,
          safetyReserveTokens: 200,
          attachmentReserveTokens: 100,
        },
        stepDefaults: { timeoutMs: 20000 },
        steps: {},
      }),
    );
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "execution.decision")
        return { text: respond(), meta: {} };
      if (input.modelStep === "degraded.finalization")
        return { text: JSON.stringify(phrasing), meta: {} };
      return {
        text: responseOutcome === "valid" ? "Established answer." : "",
        meta: {},
      };
    });
    const store = createInMemorySessionStore();
    const updateTitle = vi.spyOn(store, "updateSessionTitle");
    const appendMessage = vi.spyOn(store, "appendMessage");
    const events: Record<string, unknown>[] = [];
    const ws = {
      send(data: string) {
        events.push(JSON.parse(data));
      },
    } as unknown as WebSocket;

    await handleRunRequest(
      ws,
      {
        type: "run_request",
        requestId: "title-request",
        sessionId: "title-session",
        input: "Report the established result.",
        agentMode: "reasoning",
        modelPreference: { profileId: "invalid-output-test", scope: "all" },
      },
      {
        runtimeConfig,
        sessionStore: store,
        modelGatewayClient: { invoke, invokeRaw: vi.fn() },
      },
    );

    const expected =
      responseOutcome === "valid" ? "Established answer." : degradedResponse;
    expect(updateTitle).toHaveBeenCalledExactlyOnceWith("title-session", title);
    const assistantWrite = appendMessage.mock.calls.findIndex(
      ([, role]) => role === "assistant",
    );
    expect(assistantWrite).toBeGreaterThanOrEqual(0);
    expect(updateTitle.mock.invocationCallOrder[0]).toBeLessThan(
      appendMessage.mock.invocationCallOrder[assistantWrite]!,
    );
    const session = await store.getSessionById("title-session");
    expect(session?.title).toBe(title);
    expect(
      session?.messages.filter(({ role }) => role === "assistant"),
    ).toEqual([expect.objectContaining({ content: expected })]);
    expect(events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(events.filter(({ type }) => type === "completed")).toEqual([
      expect.objectContaining({ output: expected }),
    ]);
    expect(
      invoke.mock.calls.filter(
        ([input]) => input.modelStep === "degraded.finalization",
      ),
    ).toHaveLength(responseOutcome === "invalid" ? 1 : 0);
  },
);

test("publishes deferred title only after steering is sealed and before root commit", async () => {
  const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "execution.decision")
      return { text: respond(), meta: {} };
    if (input.modelStep === "degraded.finalization")
      return { text: JSON.stringify(phrasing), meta: {} };
    return { text: "", meta: {} };
  });
  const onSessionTitle = vi.fn(async () => {
    expect(
      steering.append({ steerId: "too-late", text: "Do something else." }),
    ).toMatchObject({ ok: false, reason: "request_not_active" });
    expect(ledger.current().state.phase).toBe("running");
    expect(ledger.current().state.rootResponse).toBeNull();
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    shouldGenerateSessionTitle: true,
    requestSteering: steering,
    onSessionTitle,
  });

  await expect(
    runRootExecutionKernel({ request, ledger }),
  ).resolves.toMatchObject({ output: degradedResponse });
  expect(onSessionTitle).toHaveBeenCalledExactlyOnceWith(title);
  expect(ledger.current().state.phase).toBe("completed");
});

test("discards a stale deferred title and publishes the fresh decision title", async () => {
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "execution.decision")
      return {
        text: respond(
          steering.snapshot().version === 0 ? "Stale title" : "Fresh title",
        ),
        meta: {},
      };
    if (input.modelStep === "degraded.finalization") {
      steering.append({ steerId: "fresh", text: "Use the fresh direction." });
      return { text: JSON.stringify(phrasing), meta: {} };
    }
    return {
      text: steering.snapshot().version === 0 ? "" : "Fresh answer.",
      meta: {},
    };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    shouldGenerateSessionTitle: true,
    requestSteering: steering,
  });
  const ledger = await createRootInvalidOutputLedger("execution-agent-v1");

  await expect(
    runRootExecutionKernel({ request, ledger }),
  ).resolves.toMatchObject({ output: "Fresh answer." });
  expect(request.onSessionTitle).toHaveBeenCalledExactlyOnceWith("Fresh title");
});

test.each([
  "decision_invalid",
  "degraded_invalid",
  "degraded_provider",
  "abort",
  "title_write",
  "title_abort",
] as const)(
  "does not fabricate or prematurely publish a title on %s",
  async (failureKind) => {
    const abort = new AbortController();
    const failure = new Error(failureKind);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "execution.decision")
        return {
          text: failureKind === "decision_invalid" ? "invalid" : respond(),
          meta: {},
        };
      if (input.modelStep !== "degraded.finalization")
        return { text: "", meta: {} };
      if (failureKind === "degraded_provider") throw failure;
      if (failureKind === "abort") abort.abort(failure);
      return {
        text:
          failureKind === "degraded_invalid"
            ? "invalid"
            : JSON.stringify(phrasing),
        meta: {},
      };
    });
    const onSessionTitle = vi.fn(async () => {
      if (failureKind === "title_write") throw failure;
      if (failureKind === "title_abort") abort.abort(failure);
    });
    const request = createRootInvalidOutputRequest(
      invoke,
      "execution-agent-v1",
      {
        shouldGenerateSessionTitle: true,
        abortSignal: abort.signal,
        onSessionTitle,
      },
    );
    const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
    const execution = runRootExecutionKernel({ request, ledger });

    if (failureKind === "decision_invalid") {
      await expect(execution).resolves.toMatchObject({
        output: degradedResponse,
      });
      expect(onSessionTitle).not.toHaveBeenCalled();
      return;
    }
    await expect(execution).rejects.toThrow(
      failureKind === "degraded_invalid"
        ? "invalid_degraded_finalization_output"
        : failureKind,
    );
    expect(onSessionTitle).toHaveBeenCalledTimes(
      failureKind.startsWith("title_") ? 1 : 0,
    );
    expect(ledger.current().state).toMatchObject({
      phase: "running",
      rootResponse: null,
    });
  },
);
