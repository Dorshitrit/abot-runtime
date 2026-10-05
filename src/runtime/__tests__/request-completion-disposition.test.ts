import { afterEach, expect, test } from "vitest";
import type WebSocket from "ws";
import { handleRunRequestWithOutcome } from "../request/handler.js";
import { createRequestCancellationError } from "../request/cancellation.js";
import type { RequestHandlerOptions } from "../request/contracts.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
const RESPONSE = "A prerequisite is missing.";
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
});

function handlerOptions(f: Fixture): RequestHandlerOptions {
  return {
    runtimeConfig: f.config,
    modelGatewayClient: { invoke: f.invoke, invokeRaw: f.invokeRaw },
    sessionStore: f.application.services.sessions,
    attachmentStore: f.application.services.attachments,
    toolRegistry: f.application.services.tools,
    longTermMemory: f.application.services.longTermMemory,
  };
}

function recordingSocket() {
  const events: Record<string, unknown>[] = [];
  const ws = { send: (data: string) => events.push(JSON.parse(data)) } as unknown as WebSocket;
  return { ws, events };
}

test.each([
  { policy: "execution-agent-v1", disposition: "responded" },
  { policy: "execution-agent-v1", disposition: "blocked" },
  { policy: "supervisor-worker-v1", disposition: "responded" },
] as const)("$policy transports $disposition without changing ordinary chat completion", async ({ policy, disposition }) => {
  const f = await createSchedulerRuntimeFixture(policy);
  fixtures.push(f);
  const defaultInvoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (input) => {
    if (disposition === "blocked") {
      if (!input.modelStep?.endsWith(".decision")) throw new Error("unexpected_response_authoring");
      return { text: JSON.stringify({ decision: { action: "blocked", response: RESPONSE, acknowledgement: "I checked the prerequisite." } }), meta: {} };
    }
    if (input.modelStep?.endsWith(".response")) return { text: RESPONSE, meta: {} };
    return defaultInvoke(input);
  });
  for (const internal of [true, false]) {
    const requestId = internal ? "internal" : "ordinary";
    const { ws, events } = recordingSocket();
    const request = {
      type: "run_request" as const, requestId, sessionId: "session", text: "Answer this request.",
      agentMode: "reasoning" as const, toolPermissionMode: "full_access" as const,
      modelPreference: { profileId: "scheduled-model", scope: "all" as const },
    };
    const outcome = internal
      ? await handleRunRequestWithOutcome(ws, request, handlerOptions(f))
      : await f.application.requests.handle(ws, request);
    if (internal) expect(outcome, JSON.stringify(events)).toEqual({ kind: "completed", disposition });
    if (!internal) expect(outcome).toBeUndefined();
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.some((event) => event.type === "failed")).toBe(false);
    const replay = await f.application.services.sessions.getRequestReplayById!(requestId, 0);
    expect(replay?.finalState).toMatchObject({ status: "completed" });
    const session = await f.application.services.sessions.getSessionById("session");
    const assistant = session?.messages.find((message) =>
      message.requestId === requestId && message.role === "assistant");
    expect(assistant?.content).toBe(RESPONSE);
  }
  const steps = f.invoke.mock.calls.map(([input]) => input.modelStep);
  if (disposition === "blocked") expect(steps.some((step) => step?.endsWith(".response"))).toBe(false);
});

test.each([
  { policy: "execution-agent-v1", cause: "failure" },
  { policy: "execution-agent-v1", cause: "cancel" },
  { policy: "supervisor-worker-v1", cause: "failure" },
  { policy: "supervisor-worker-v1", cause: "cancel" },
] as const)("$policy does not report completed disposition after $cause", async ({ policy, cause }) => {
  const f = await createSchedulerRuntimeFixture(policy);
  fixtures.push(f);
  const controller = new AbortController();
  f.invoke.mockImplementation(async () => {
    if (cause === "cancel") {
      controller.abort(createRequestCancellationError());
      throw controller.signal.reason;
    }
    throw new Error("test_model_failed");
  });
  const { ws, events } = recordingSocket();
  const outcome = await handleRunRequestWithOutcome(ws, {
    type: "run_request", requestId: "failed", sessionId: "session", text: "Answer this request.",
    agentMode: "reasoning", toolPermissionMode: "full_access",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  }, { ...handlerOptions(f), abortSignal: controller.signal });
  expect(outcome).toBeUndefined();
  expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
  expect(events.some((event) => event.type === "completed")).toBe(false);
  const replay = await f.application.services.sessions.getRequestReplayById!("failed", 0);
  expect(replay?.finalState).toMatchObject({ status: "failed" });
  if (cause === "cancel") expect(replay?.finalState).toMatchObject({ error: "request_cancelled" });
});
