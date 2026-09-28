import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRuntimeConfig,
  disposeCompositionFixtures,
} from "./support/runtime-composition-fixture.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";

vi.mock("../request/runner.js", () => ({ runRequestRunner: vi.fn() }));

const PROMPT = "Write a short summary.";
const STEERING = "Include the saved preference.";
const OUTPUT = "The completed summary.";
const releases: (() => void)[] = [];

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  vi.mocked(runRequestRunner).mockReset();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

async function fixture(blockedText: string, failAppend: boolean) {
  const runtimeConfig = await createRuntimeConfig();
  await writeFile(
    runtimeConfig.requestRunner.configPath!,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 1000 },
      steps: {},
    }),
  );
  runtimeConfig.models = {
    defaults: { profileId: "test" },
    providers: { local: { type: "ollama" } },
    profiles: {
      test: { provider: "local", model: "unused", contextWindowTokens: 64000 },
    },
  };
  const store = createInMemorySessionStore();
  const append = store.appendMessage;
  const entered = createSchedulerTestGate();
  const release = createSchedulerTestGate();
  releases.push(release.open);
  vi.spyOn(store, "appendMessage").mockImplementation(async (...args) => {
    if (args[2] === blockedText) {
      entered.open();
      await release.waiting;
      if (failAppend) throw new Error("message_commit_failed");
    }
    return append(...args);
  });
  const inbox = createRequestSteeringInbox({ requestId: "request" });
  const frames: Record<string, unknown>[] = [];
  const committedReads: ReturnType<typeof store.getSessionById>[] = [];
  const socket = {
    send(raw: string) {
      const event = JSON.parse(raw);
      frames.push(event);
      if (event.name === "session.messages.updated")
        committedReads.push(store.getSessionById("session"));
    },
  } as unknown as WebSocket;
  const invoke = vi.fn(async () => {
    throw new Error("unexpected_model_call");
  });
  return {
    store,
    inbox,
    frames,
    committedReads,
    invoke,
    entered,
    release,
    changes: () =>
      frames.filter((frame) => frame.name === "session.messages.updated"),
    run: () =>
      handleRunRequest(
        socket,
        {
          type: "run_request",
          requestId: "request",
          sessionId: "session",
          text: PROMPT,
          agentMode: "reasoning",
        },
        {
          runtimeConfig,
          sessionStore: store,
          requestSteering: inbox,
          modelGatewayClient: { invoke, invokeRaw: invoke },
        },
      ),
  };
}

test.each([false, true])(
  "initial user append announces only a successful commit (failure: %s)",
  async (failed) => {
    const f = await fixture(PROMPT, failed);
    vi.mocked(runRequestRunner).mockResolvedValue({ output: OUTPUT });
    const running = f.run();
    await f.entered.waiting;
    expect(f.changes()).toEqual([]);
    expect(runRequestRunner).not.toHaveBeenCalled();
    f.release.open();
    await running;
    if (failed) {
      expect(f.changes()).toEqual([]);
      expect(runRequestRunner).not.toHaveBeenCalled();
      expect(f.frames).toContainEqual(
        expect.objectContaining({
          type: "failed",
          error: "message_commit_failed",
        }),
      );
      return;
    }
    expect(f.changes()).toEqual([
      expect.objectContaining({
        type: "event",
        name: "session.messages.updated",
        requestId: "request",
        sessionId: "session",
      }),
    ]);
    expect((await f.committedReads[0])?.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: PROMPT }),
    );
    expect(runRequestRunner).toHaveBeenCalledOnce();
    expect(vi.mocked(runRequestRunner).mock.calls[0][0]).toMatchObject({
      prompt: PROMPT,
      historyMessages: [],
    });
    expect(f.frames).toContainEqual(
      expect.objectContaining({ type: "completed", output: OUTPUT }),
    );
    expect(
      (await f.store.getSessionById("session"))?.messages.at(-1),
    ).toMatchObject({ role: "assistant", content: OUTPUT });
    expect(f.invoke).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "steering announces its saved message without changing continuation (failure: %s)",
  async (failed) => {
    const f = await fixture(STEERING, failed);
    const continueRunner = createSchedulerTestGate();
    releases.push(continueRunner.open);
    vi.mocked(runRequestRunner).mockImplementation(async (request) => {
      expect(request.prompt).toBe(PROMPT);
      expect(request.historyMessages).toEqual([]);
      expect(
        request.requestSteering?.append({ steerId: "update", text: STEERING }),
      ).toMatchObject({ ok: true });
      await continueRunner.waiting;
      expect(request.requestSteering?.snapshot()).toMatchObject({
        version: 1,
        updates: [{ steerId: "update", sequence: 1, text: STEERING }],
      });
      return { output: OUTPUT };
    });
    const running = f.run();
    await f.entered.waiting;
    expect(f.changes()).toHaveLength(1);
    expect(
      (await f.store.getSessionById("session"))?.messages.map(
        (message) => message.content,
      ),
    ).toEqual([PROMPT]);
    f.release.open();
    await f.inbox.close();
    expect(f.changes()).toHaveLength(failed ? 1 : 2);
    if (!failed)
      expect(
        (await f.committedReads[1])?.messages.map((message) => message.content),
      ).toEqual([PROMPT, STEERING]);
    continueRunner.open();
    await running;
    expect(runRequestRunner).toHaveBeenCalledOnce();
    expect(f.frames.filter((event) => event.type === "failed")).toEqual([]);
    expect(f.frames).toContainEqual(
      expect.objectContaining({ type: "completed", output: OUTPUT }),
    );
    expect(
      (await f.store.getSessionById("session"))?.messages.map(
        (message) => message.content,
      ),
    ).toEqual(failed ? [PROMPT, OUTPUT] : [PROMPT, STEERING, OUTPUT]);
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
