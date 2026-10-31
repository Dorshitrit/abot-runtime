import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { attachModelGatewayHttpUserMessage } from "../../model-gateway/client/user-message.js";
import { encodeProviderUserError } from "../../model-gateway/protocol/provider-user-error.js";
import { SessionService } from "../../sessions/session-service.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestCancellationError } from "../request/cancellation.js";
import { handleRunRequest } from "../request/handler.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

const failures = [
  {
    code: "ollama_model_not_found",
    status: 404,
    response: "Model \"missing:1b\" isn't installed in Ollama at http://127.0.0.1:11434. Run `ollama pull missing:1b` on the machine running Ollama, then try again.",
  },
  {
    code: "ollama_unreachable",
    status: 500,
    response: "Can't reach Ollama at http://127.0.0.1:11434. Check that Ollama is running and that its address is correct.",
  },
] as const;
const policies = ["supervisor-worker-v1", "execution-agent-v1"] as const;

const cases = policies.flatMap((policy) => [
  ...failures.map((failure) => ({ policy, failure, cancel: false })),
  { policy, failure: failures[0], cancel: true },
]);

test.each(cases)(
  "$policy durable $failure.code with cancel=$cancel keeps live and saved terminal presentation identical",
  async ({ policy, failure, cancel }) => {
    const h = await createFailureHarness(policy);
    const sessions = new SessionService({ sessionsDir: h.runtimeConfig.paths.sessionsDir });
    await sessions.getOrCreateSession("durable-failure-session");
    await sessions.updateSessionTitle("durable-failure-session", "Existing conversation");
    const abort = new AbortController();
    const header = encodeProviderUserError({
      code: failure.code, endpoint: "http://127.0.0.1:11434", model: "missing:1b",
    });
    const error = attachModelGatewayHttpUserMessage(
      new ModelGatewayInvocationError("http", `bridge_request_failed:${failure.status}:PRIVATE_PROVIDER_BODY`),
      failure.status, header, true,
    );
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      if (cancel) abort.abort(createRequestCancellationError());
      throw error;
    });
    const events: Record<string, unknown>[] = [];
    await handleRunRequest(
      { send: (raw: string) => events.push(JSON.parse(raw)) } as unknown as WebSocket,
      {
        type: "run_request", requestId: "durable-failure-request",
        sessionId: "durable-failure-session", input: "Finish the requested work.",
        agentMode: "reasoning", modelPreference: { profileId: "invalid-output-test", scope: "all" },
      },
      {
        runtimeConfig: h.runtimeConfig, sessionStore: sessions,
        modelGatewayClient: { invoke, invokeRaw: vi.fn() },
        abortSignal: abort.signal, durableApprovals: true,
        approvalExecution: { activation: { activationId: "activation", ownerEpoch: "owner" } },
      },
    );
    const diagnostic = cancel ? "request_cancelled" : error.message;
    const response = cancel ? "I stopped the task at your request." : failure.response;
    expect(invoke).toHaveBeenCalled();
    expect(invoke.mock.calls.some(([input]) => input.modelStep === "degraded.finalization")).toBe(false);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    const live = events.filter((event) => event.type === "failed");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      error: diagnostic, details: { stoppedResponse: response },
    });
    expect(JSON.stringify(live[0].details)).not.toContain("PRIVATE_PROVIDER_BODY");

    const storedReplay = await sessions.getRequestReplayById("durable-failure-request");
    expect(storedReplay!.lifecycle?.status).toBe("failed");
    expect(storedReplay!.lifecycle?.terminalCause).toBe(cancel ? "request_cancelled" : "request_failed");
    expect(storedReplay!.events.filter((event) => event.type === "failed")).toEqual(live);
    expect(storedReplay!.finalState).toMatchObject({ status: "failed", error: diagnostic });

    // A fresh service reads the durable record rather than an in-memory projection.
    const reopened = new SessionService({ sessionsDir: h.runtimeConfig.paths.sessionsDir });
    const replay = await reopened.getRequestReplayById("durable-failure-request");
    expect(replay!.events.filter((event) => event.type === "failed")).toEqual(live);
    expect(replay!.finalState).toEqual(storedReplay!.finalState);
    const saved = await reopened.getSessionById("durable-failure-session");
    const assistant = saved!.messages.filter((message) =>
      message.role === "assistant" && message.requestId === "durable-failure-request");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ kind: "terminal", content: response });
    expect(assistant[0].content).not.toContain("PRIVATE_PROVIDER_BODY");
    if (cancel) expect(assistant[0].content).not.toContain("Ollama");
  },
);
