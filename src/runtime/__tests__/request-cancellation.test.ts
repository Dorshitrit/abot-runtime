import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { handleRunRequest } from "../request/handler.js";
import { createRequestCancellationError } from "../request/cancellation.js";
import { SessionRequestAdmission } from "../request/session-admission.js";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";
import {
  createRuntimeConfig,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";
import {
  INVALID_OUTPUT_MODEL_POLICY,
  ROOT_OUTPUT_POLICIES,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each(ROOT_OUTPUT_POLICIES)("$policyId cancellation", (policy) => {
  test.each([
    "before_start",
    "decision",
    "response",
    "late_result",
    "delivered_answer",
    "persistence_failure",
  ] as const)(
    "stops at %s, persists one terminal failure, then accepts a new request",
    async (phase) => {
      const runtimeConfig = {
        ...(await createRuntimeConfig()),
        plugins: { enabled: false },
        models: INVALID_OUTPUT_MODEL_POLICY,
        modelExecutionPolicies: {
          "invalid-output-test": { policy: policy.policyId },
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
          stepDefaults: { timeoutMs: 2000 },
          steps: {},
        }),
      );
      const sessionStore = createInMemorySessionStore();
      await sessionStore.getOrCreateSession("session");
      if (phase !== "before_start") {
        await sessionStore.updateSessionTitle(
          "session",
          "Existing conversation",
        );
      }
      const abort = new AbortController();
      const cancellation = createRequestCancellationError();
      if (phase === "before_start") abort.abort(cancellation);
      let stopping = true;
      const appendMessage = sessionStore.appendMessage.bind(sessionStore);
      if (phase === "persistence_failure") {
        vi.spyOn(sessionStore, "appendMessage").mockImplementation(
          async (...args) => {
            if (stopping && args[1] === "assistant")
              throw new Error("Disk unavailable");
            return appendMessage(...args);
          },
        );
      }
      const resumedDecision = JSON.parse(rootRespondOutput(policy.policyId));
      if (phase === "before_start")
        resumedDecision.decision.title = "Resumed work";
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        const response =
          input.modelStep === policy.decisionStep
            ? JSON.stringify(resumedDecision)
            : "The new request completed.";
        const stopHere =
          stopping &&
          phase !== "delivered_answer" &&
          (phase === "decision" ||
            phase === "late_result" ||
            input.modelStep === policy.responseStep);
        if (!stopHere) return { text: response, meta: {} };
        abort.abort(cancellation);
        if (phase === "late_result") return { text: response, meta: {} };
        input.abortSignal.throwIfAborted();
        throw new Error("The request signal was not propagated");
      });
      const events: Record<string, unknown>[] = [];
      const ws = {
        send: (data: string) => {
          const event = JSON.parse(data);
          events.push(event);
          if (
            stopping &&
            phase === "delivered_answer" &&
            event.type === "token"
          )
            abort.abort(cancellation);
        },
      } as unknown as WebSocket;
      const request = {
        type: "run_request" as const,
        requestId: "stopped",
        sessionId: "session",
        text: "Complete the requested work.",
        agentMode: "reasoning",
        modelPreference: { profileId: "invalid-output-test", scope: "all" },
      };
      const invokeRaw: ModelGatewayClient["invokeRaw"] = async (input) => ({
        ...(await invoke(input)),
        meta: { status: 200, outputLength: 0, thinkingLength: 0 },
      });
      const options = {
        runtimeConfig,
        sessionStore,
        modelGatewayClient: { invoke, invokeRaw },
      };
      await handleRunRequest(ws, request, {
        ...options,
        abortSignal: abort.signal,
      });
      expect(events.filter((event) => event.type === "failed")).toEqual([
        expect.objectContaining({
          requestId: "stopped",
          error: "request_cancelled",
        }),
      ]);
      expect(events.some((event) => event.type === "completed")).toBe(false);
      expect(
        invoke.mock.calls.some(
          ([input]) => input.modelStep === "degraded.finalization",
        ),
      ).toBe(false);
      if (phase === "before_start") expect(invoke).not.toHaveBeenCalled();
      const saved = await sessionStore.getSessionById("session");
      const assistant = saved?.messages.find(
        (message) => message.role === "assistant",
      );
      if (phase === "persistence_failure") {
        expect(saved?.messages.map((message) => message.role)).toEqual([
          "user",
        ]);
        expect(events.at(-1)).toMatchObject({
          type: "failed",
          details: { stoppedResponsePersistenceFailed: true },
        });
      } else {
        expect(saved?.messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(assistant).toMatchObject({
          requestId: "stopped",
          source: "request",
        });
        expect(assistant?.content.trim()).toBeTruthy();
        expect(events.at(-1)).toMatchObject({
          type: "failed",
          details: { stoppedResponse: assistant?.content },
        });
        if (phase === "delivered_answer")
          expect(assistant?.content).toMatch(/^The new request completed\./);
      }
      expect(
        (await sessionStore.getRequestReplayById("stopped", 0))?.finalState,
      ).toMatchObject({ status: "failed", error: "request_cancelled" });
      stopping = false;
      events.length = 0;
      invoke.mockClear();
      await handleRunRequest(
        ws,
        { ...request, requestId: "next", text: "New request." },
        options,
      );
      expect(events.filter((event) => event.type === "completed")).toHaveLength(
        1,
      );
      expect(events.some((event) => event.type === "failed")).toBe(false);
      const nextMessages = invoke.mock.calls[0]?.[0].messages as {
        role: string;
        content: string;
      }[];
      expect(
        nextMessages.filter(
          (message) =>
            message.role === "user" && message.content === "New request.",
        ),
      ).toHaveLength(1);
      if (assistant) {
        const priorUser = nextMessages.findIndex(
          (message) =>
            message.role === "user" && message.content === request.text,
        );
        expect(priorUser).toBeGreaterThan(-1);
        expect(nextMessages[priorUser + 1]).toMatchObject({
          role: "assistant",
          content: assistant.content,
        });
      }
      expect((await sessionStore.getSessionById("session"))?.title).toBe(
        phase === "before_start" ? "Resumed work" : "Existing conversation",
      );
    },
  );
});

test("cancelling queued work preserves scheduled-session isolation until its reservation ends", async () => {
  const admission = new SessionRequestAdmission(() => false);
  const release = admission.tryReserve("session")!;
  const abort = new AbortController();
  const execute = vi.fn(async () => {
    expect(abort.signal.aborted).toBe(true);
  });
  const pending = admission.run("session", execute);
  expect(execute).not.toHaveBeenCalled();
  abort.abort(createRequestCancellationError());
  await Promise.resolve();
  expect(execute).not.toHaveBeenCalled();
  expect(admission.tryReserve("session")).toBeNull();
  release();
  await pending;
  expect(execute).toHaveBeenCalledOnce();
  expect(admission.isIdle()).toBe(true);
});

test("owner cancellation is scoped, idempotent, rejects steering and dismisses pending approval", async () => {
  const callClient = vi.fn<LocalRuntimePeer["callClient"]>(
    () => new Promise(() => {}),
  );
  const peer: LocalRuntimePeer = {
    id: "peer",
    callClient,
    onClose: () => () => {},
  };
  const controls = new LocalRequestControls(() => {});
  const active = controls.ordinary(
    "request",
    peer,
    { approvalAvailable: true },
    "session",
  );
  const other = controls.ordinary("other", peer, {}, "other-session");
  const pending = active.toolApprovalController!.requestToolApproval(
    { approvalId: "approval", requestId: "request" } as never,
    { abortSignal: active.abortSignal },
  );
  expect(controls.cancel("request", "other-session").accepted).toBe(false);
  expect(active.abortSignal?.aborted).toBe(false);
  expect(controls.cancel("request", "session")).toEqual({ accepted: true });
  expect(controls.cancel("request", "session")).toEqual({ accepted: true });
  expect(other.abortSignal?.aborted).toBe(false);
  await expect(pending).rejects.toThrow("request_cancelled");
  expect(callClient).toHaveBeenCalledWith("request.approval.cancel", [
    "approval",
  ]);
  expect(
    controls.steer("request", { steerId: "late", text: "Continue" }),
  ).toMatchObject({ ok: false });
  controls.finish("request");
  expect(controls.cancel("request", "session")).toMatchObject({
    accepted: false,
    reason: "request_not_active",
  });
  controls.stop();
});
