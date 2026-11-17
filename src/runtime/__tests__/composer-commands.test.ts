import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";
import { parseRuntimeCommand, RUNTIME_COMMANDS } from "../commands/catalog.js";
import { validateCommandRequest } from "../commands/run.js";
import { createBoundBridgeRequestHandler } from "../../bridge/bound-request-handler.js";
import type { ModelGatewayClient } from "../ports.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture(
  policy: "execution-agent-v1" | "supervisor-worker-v1" = "execution-agent-v1",
  turns = 12,
) {
  const f = await createSchedulerRuntimeFixture(policy);
  cleanup.push(f.dispose);
  const ordinaryModel = f.invoke.getMockImplementation()!;
  for (let i = 1; i < turns; i++) {
    await f.application.services.sessions.appendMessage(
      "session",
      "user",
      `Preference ${i}: ${"history detail ".repeat(90)}`,
      { requestId: `history-${i}` },
    );
    await f.application.services.sessions.appendMessage(
      "session",
      "assistant",
      `Settled result ${i}: ${"observed fact ".repeat(90)}`,
      { requestId: `history-${i}` },
    );
  }
  f.invoke.mockImplementation(async () => ({
    text: JSON.stringify({
      summary: "The user prefers concise answers. Earlier work is settled.",
    }),
    meta: {},
  }));
  f.invokeRaw.mockImplementation(async () => ({
    text: "The user prefers concise answers. Earlier work is settled.",
    meta: { status: 200, outputLength: 57, thinkingLength: 0 },
  }));
  const events: Record<string, unknown>[] = [];
  const ws = {
    send(data: string) {
      events.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const message = {
    type: "run_request",
    requestId: "command-1",
    sessionId: "session",
    command: { name: "compact", mode: "run" },
    modelPreference: { profileId: "scheduled-model" },
  };
  return {
    ...f,
    ordinaryModel,
    events,
    get terminalEvents() {
      return events.filter(
        (event) => event.type === "completed" || event.type === "failed",
      );
    },
    ws,
    message,
    read: () => f.application.services.sessions.getOrCreateSession("session"),
  };
}

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s compacts below threshold without a chat turn or response model",
  async (policy) => {
    const f = await fixture(policy);
    const before = await f.read();
    await f.application.requests.handle(f.ws, f.message);
    const after = await f.read();
    expect(after.messages).toEqual(before.messages);
    const checkpoint =
      policy === "execution-agent-v1"
        ? after.executionSessionMemoryCheckpoint
        : after.sessionMemoryCheckpoint;
    expect(checkpoint?.summary).toBeTruthy();
    expect(checkpoint?.coveredMessages).toHaveLength(
      policy === "execution-agent-v1" ? 24 : 4,
    );
    expect(f.events.map((event) => event.name)).toEqual([
      "command.started",
      "context.compaction.completed",
    ]);
    expect(f.terminalEvents).toHaveLength(1);
    expect(f.terminalEvents[0]).toMatchObject({
      type: "completed",
      requestKind: "command",
      name: "context.compaction.completed",
      outcome: "compacted",
      reason: "user_command",
    });
    expect(f.terminalEvents[0]).not.toHaveProperty("output");
    expect(
      after.requests?.find((entry) => entry.requestId === "command-1")?.status,
    ).toBe("completed");
    const steps = [...f.invoke.mock.calls, ...f.invokeRaw.mock.calls].map(
      ([input]) => input.modelStep,
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => String(step).includes("compact"))).toBe(true);
    const sourceCalls = f.invoke.mock.calls.map(([input]) =>
      JSON.stringify(input.messages),
    );
    expect(sourceCalls.some((messages) => messages.includes("/compact"))).toBe(
      false,
    );
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s measures history as text even when the decision step defaults to JSON",
  async (policy) => {
    const f = await fixture(policy);
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => {
      if (
        input.modelStep === "execution.decision" ||
        input.modelStep === "supervisor.decision"
      ) {
        // Input-count endpoints validate response-format constraints too.
        if (typeof input.format !== "object" || input.format.type !== "text")
          throw new Error("json_object_requires_json_instruction");
      }
      return {
        inputTokens: Math.ceil(JSON.stringify(input.messages).length / 4),
        profileId: "scheduled-model",
        provider: "ollama",
        model: "scripted",
        contextWindowTokens: 64000,
        source: "provider_input_token_count",
      };
    });
    f.application.services.models.countInputTokens = countInputTokens;
    await f.application.requests.handle(f.ws, f.message);
    expect(countInputTokens).toHaveBeenCalled();
    expect(f.terminalEvents).toEqual([
      expect.objectContaining({ type: "completed", outcome: "compacted" }),
    ]);
  },
);

test("SUPER keeps ten protected turns and reports no change without calling a model", async () => {
  const f = await fixture("supervisor-worker-v1", 10);
  const before = await f.read();
  await f.application.requests.handle(f.ws, f.message);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.invokeRaw).not.toHaveBeenCalled();
  expect((await f.read()).messages).toEqual(before.messages);
  expect(f.terminalEvents).toEqual([
    expect.objectContaining({
      type: "completed",
      outcome: "no_change",
      reason: "no_eligible_sources",
      protectedTurnLimit: 10,
    }),
  ]);
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "an empty %s conversation has no protected-history explanation",
  async (policy) => {
    const f = await fixture(policy, 1);
    await f.application.services.sessions.getOrCreateSession("empty");
    await f.application.requests.handle(f.ws, { ...f.message, sessionId: "empty" });
    expect(f.terminalEvents[0]).toMatchObject({ outcome: "no_change" });
    expect(f.terminalEvents[0]).not.toHaveProperty("protectedTurnLimit");
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.invokeRaw).not.toHaveBeenCalled();
  },
);

test("the standalone Bridge shares command execution and never enters the chat response path", async () => {
  const f = await fixture();
  const handler = createBoundBridgeRequestHandler({
    runtimeConfig: f.config,
    sessionStore: f.application.services.sessions,
    modelGatewayClient: { invoke: f.invoke, invokeRaw: f.invokeRaw },
  });
  await handler.handle(f.ws, f.message);
  expect(f.terminalEvents).toEqual([
    expect.objectContaining({
      type: "completed",
      requestKind: "command",
      outcome: "compacted",
    }),
  ]);
  expect((await f.read()).executionSessionMemoryCheckpoint?.revision).toBe(1);
});

test("generation failure leaves history and checkpoint intact and emits only failure", async () => {
  const f = await fixture();
  f.invoke.mockRejectedValue(new Error("model_unavailable"));
  const before = await f.read();
  await f.application.requests.handle(f.ws, f.message);
  const after = await f.read();
  expect(after.messages).toEqual(before.messages);
  expect(after.executionSessionMemoryCheckpoint).toBeUndefined();
  expect(f.terminalEvents).toEqual([
    expect.objectContaining({
      type: "failed",
      requestKind: "command",
      error: "model_unavailable",
    }),
  ]);
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s reuses the saved checkpoint on the following ordinary turn",
  async (policy) => {
    const f = await fixture(policy);
    await f.application.requests.handle(f.ws, f.message);
    f.invoke.mockClear().mockImplementation(f.ordinaryModel);
    await f.runOrdinaryRequest("Apply my earlier preference.");
    const inputs = f.invoke.mock.calls.map(([input]) =>
      JSON.stringify(input.messages),
    );
    expect(
      inputs.some((input) => input.includes("Earlier work is settled.")),
    ).toBe(true);
    expect(inputs.some((input) => input.includes("Preference 1:"))).toBe(false);
    expect((await f.read()).messages.at(-1)?.role).toBe("assistant");
  },
);

test("a non-reducing candidate is rejected without committing a checkpoint", async () => {
  const f = await fixture("execution-agent-v1", 1);
  f.invoke.mockResolvedValue({
    text: JSON.stringify({ summary: "An expanded summary. ".repeat(100) }),
    meta: {},
  });
  await f.application.requests.handle(f.ws, f.message);
  expect((await f.read()).executionSessionMemoryCheckpoint).toBeUndefined();
  expect(f.terminalEvents).toEqual([
    expect.objectContaining({ type: "failed", requestKind: "command" }),
  ]);
});

test("a source change during preparation rejects the stale checkpoint", async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async () => {
    await f.application.services.sessions.appendMessage(
      "session",
      "user",
      "A concurrent history edit.",
    );
    await f.application.services.sessions.appendMessage(
      "session",
      "assistant",
      "A settled concurrent answer.",
    );
    return { text: JSON.stringify({ summary: "Earlier history." }), meta: {} };
  });
  await f.application.requests.handle(f.ws, f.message);
  expect((await f.read()).executionSessionMemoryCheckpoint).toBeUndefined();
  expect(f.terminalEvents).toEqual([
    expect.objectContaining({
      type: "failed",
      error: expect.stringContaining("session_memory_"),
    }),
  ]);
});

test("closed live delivery cannot rewrite a persisted successful command as failed", async () => {
  const f = await fixture();
  const ws = {
    send() {
      throw new Error("connection_closed");
    },
  } as unknown as WebSocket;
  await f.application.requests.handle(ws, f.message);
  const request = (await f.read()).requests?.find(
    (entry) => entry.requestId === f.message.requestId,
  );
  expect(request?.status).toBe("completed");
  expect(
    request?.events.filter((entry) => entry.type === "completed"),
  ).toHaveLength(1);
  expect(request?.events.some((entry) => entry.type === "failed")).toBe(false);
});

test("admission acknowledgement sees a classified stream and commit claims finalization once", async () => {
  const f = await fixture();
  const claimFinalization = vi.fn();
  const onAccepted = vi.fn(async () => {
    const request = (await f.read()).requests?.find(
      (entry) => entry.requestId === f.message.requestId,
    );
    expect(request?.events[0]?.payload).toMatchObject({
      requestKind: "command",
      name: "command.started",
    });
  });
  await f.application.requests.handle(f.ws, f.message, {
    onAccepted,
    claimFinalization,
  });
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(claimFinalization).toHaveBeenCalledOnce();
});

test("command admission excludes a concurrent chat and cancellation never commits its candidate", async () => {
  const f = await fixture();
  const entered = createSchedulerTestGate(),
    release = createSchedulerTestGate();
  const abort = new AbortController();
  f.invoke.mockImplementation(async () => {
    entered.open();
    await release.waiting;
    return { text: JSON.stringify({ summary: "Settled history." }), meta: {} };
  });
  const running = f.application.requests.handle(f.ws, f.message, {
    abortSignal: abort.signal,
  });
  await entered.waiting;
  await expect(f.runOrdinaryRequest("hello")).rejects.toThrow("session_busy");
  abort.abort();
  release.open();
  await running;
  expect((await f.read()).executionSessionMemoryCheckpoint).toBeUndefined();
  expect(f.terminalEvents).toHaveLength(1);
  expect(f.terminalEvents[0]?.type).toBe("failed");
});

test("repeated request identity cannot execute the command again", async () => {
  const f = await fixture();
  await f.application.requests.handle(f.ws, f.message);
  const calls = f.invoke.mock.calls.length;
  await expect(f.application.requests.handle(f.ws, f.message)).rejects.toThrow(
    "command_request_already_exists",
  );
  expect(f.invoke).toHaveBeenCalledTimes(calls);
  expect(
    (await f.read()).requests?.find((entry) => entry.requestId === "command-1")
      ?.status,
  ).toBe("completed");
});

test("command modes belong to definitions and steer requires an explicit active target", () => {
  expect(() =>
    parseRuntimeCommand({
      name: "compact",
      mode: "steer",
      targetRequestId: "active",
    }),
  ).toThrow("command_mode_not_supported");
  const future = [
    { ...RUNTIME_COMMANDS[0]!, name: "future", modes: ["steer" as const] },
  ];
  expect(
    parseRuntimeCommand(
      { name: "future", mode: "steer", targetRequestId: "active" },
      future,
    ),
  ).toEqual({ name: "future", mode: "steer", targetRequestId: "active" });
  expect(() =>
    parseRuntimeCommand({ name: "future", mode: "steer" }, future),
  ).toThrow("command_target_required");
  expect(() =>
    validateCommandRequest({
      type: "run_request",
      requestId: "x",
      sessionId: "s",
      text: "hidden work",
      command: { name: "compact", mode: "run" },
    }),
  ).toThrow("command_text_not_supported");
});
