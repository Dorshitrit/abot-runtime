import type WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { publishCompletedOutput } from "../../shared/completion-disposition.js";
import { handleRunRequestWithOutcome } from "../request/handler.js";
import type { RequestCompletionDisposition } from "../request/result.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../request/runner.js", () => ({ runRequestRunner: mocks.run }));

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.run.mockReset();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

const cases = [false, true].flatMap((durable) =>
  ([undefined, "responded", "blocked"] as const).map((disposition) => ({
    durable,
    disposition,
  })),
);

test.each(cases)(
  "handler preserves completion disposition $disposition with durable=$durable",
  async ({ durable, disposition }) => {
    const h = await createFailureHarness();
    const sessions = new SessionService({
      sessionsDir: h.runtimeConfig.paths.sessionsDir,
    });
    const result = {
      output: "The requested action could not be performed.",
      ...(disposition ? { disposition } : {}),
    };
    mocks.run.mockImplementation(async (_request, options) =>
      options?.durableApproval ? { kind: "completed", result } : result,
    );
    const invoke = vi.fn(async () => {
      throw new Error("model_call_not_expected");
    });
    const outcome = await handleRunRequestWithOutcome(
      {
        send: (raw: string) => h.events.push(JSON.parse(raw)),
      } as unknown as WebSocket,
      {
        type: "run_request",
        requestId: "completion-request",
        sessionId: "completion-session",
        input: "Perform the requested action.",
        agentMode: "reasoning",
        modelPreference: { profileId: "invalid-output-test", scope: "all" },
      },
      {
        runtimeConfig: h.runtimeConfig,
        sessionStore: sessions,
        modelGatewayClient: { invoke, invokeRaw: vi.fn() },
        ...(durable
          ? {
              durableApprovals: true,
              approvalExecution: {
                activation: { activationId: "activation", ownerEpoch: "owner" },
              },
            }
          : {}),
      },
    );
    expect(outcome).toEqual({
      kind: "completed",
      disposition: disposition ?? "responded",
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    const live = h.events.filter((event) => event.type === "completed");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ output: result.output });
    expectDisplayDisposition(live[0], disposition);
    expect(h.events.some((event) => event.type === "failed")).toBe(false);

    // Reopen disk storage so the assertion covers serialization as well as live events.
    const reopened = new SessionService({
      sessionsDir: h.runtimeConfig.paths.sessionsDir,
    });
    const replay = await reopened.getRequestReplayById("completion-request");
    const completed = replay!.events.filter(
      (event) => event.type === "completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ output: result.output });
    expectDisplayDisposition(completed[0], disposition);
    expect(replay!.finalState).toMatchObject({
      status: "completed",
      output: result.output,
    });
    expectDisplayDisposition(replay!.finalState!, disposition);
    if (durable) expect(replay!.lifecycle?.status).toBe("completed");
    const stored = await reopened.getSessionById("completion-session");
    const assistant = stored!.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(result.output);
    expect(assistant[0]).not.toHaveProperty("disposition");
  },
);

test.each([undefined, "responded", "blocked"] as const)(
  "legacy sinks retain one-argument calls except explicit blocked: %s",
  (disposition) => {
    const completed = vi.fn();
    publishCompletedOutput({ completed }, "Response", disposition);
    expect(completed.mock.calls).toEqual([
      disposition === "blocked" ? ["Response", "blocked"] : ["Response"],
    ]);
  },
);

function expectDisplayDisposition(
  value: object,
  disposition: RequestCompletionDisposition | undefined,
): void {
  if (disposition === "blocked")
    expect(value).toHaveProperty("disposition", "blocked");
  else expect(value).not.toHaveProperty("disposition");
}
