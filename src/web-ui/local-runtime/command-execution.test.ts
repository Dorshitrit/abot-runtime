import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "../../runtime/__tests__/support/scheduler-runtime-fixture.js";
import { LocalRequestExecution } from "./request-execution.js";
import { RealtimeClientHub } from "./realtime-hub.js";
import { handleChatCommandCatalog } from "./chat-command-catalog.js";
import { readBody, readJsonBody } from "./http.js";
import type { RuntimeEnvironment } from "./contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const runtime = await createSchedulerRuntimeFixture("execution-agent-v1");
  cleanup.push(runtime.dispose);
  await runtime.application.services.sessions.appendMessage(
    "session",
    "user",
    "Earlier preference: ".repeat(100),
  );
  await runtime.application.services.sessions.appendMessage(
    "session",
    "assistant",
    "Earlier answer: ".repeat(100),
  );
  runtime.invoke.mockResolvedValue({
    text: JSON.stringify({ summary: "The user prefers concise replies." }),
    meta: {},
  });
  const events: Record<string, unknown>[] = [];
  const execution = new LocalRequestExecution(
    new RealtimeClientHub((event) => events.push(event)),
  );
  const server = createServer((request, response) => {
    if (
      handleChatCommandCatalog(request.method!, request.url!.slice(1), response)
    )
      return;
    void readBody(request)
      .then((body) =>
        execution.start(
          response,
          readJsonBody(body),
          "test",
          runtime.application as unknown as RuntimeEnvironment,
        ),
      )
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await vi.waitFor(() => expect(execution.healthDetails()).toHaveLength(0));
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("listener_missing");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: Record<string, unknown>) =>
    fetch(`${origin}/chat/messages`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "session",
        modelPreference: { profileId: "scheduled-model" },
        ...body,
      }),
    });
  return { ...runtime, execution, events, origin, post };
}

test("HTTP catalog and metadata reach the existing compactor with start and terminal events", async () => {
  const f = await fixture();
  const catalog = await (await fetch(`${f.origin}/chat/commands`)).json();
  expect(catalog.commands).toContainEqual(
    expect.objectContaining({ name: "compact", modes: ["run"] }),
  );
  const before =
    await f.application.services.sessions.getOrCreateSession("session");
  const response = await f.post({ command: { name: "compact", mode: "run" } });
  expect(response.status).toBe(200);
  const { requestId } = await response.json();
  await vi.waitFor(() => expect(f.execution.healthDetails()).toHaveLength(0));
  expect(f.events).toEqual([
    expect.objectContaining({
      type: "event",
      name: "command.started",
      requestKind: "command",
      requestId,
    }),
    expect.objectContaining({
      type: "completed",
      name: "context.compaction.completed",
      requestKind: "command",
      requestId,
      outcome: "compacted",
      environment: "test",
    }),
  ]);
  const after =
    await f.application.services.sessions.getOrCreateSession("session");
  expect(after.messages).toEqual(before.messages);
  expect(after.executionSessionMemoryCheckpoint?.revision).toBe(1);
});

test("HTTP refuses unsupported modes and hidden chat work before executing a model", async () => {
  const f = await fixture();
  for (const body of [
    { command: { name: "compact", mode: "steer", targetRequestId: "other" } },
    { command: { name: "compact", mode: "run" }, text: "hidden work" },
    { command: { name: "missing", mode: "run" } },
  ])
    expect((await f.post(body)).status).toBe(400);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

test("a command owns session admission until it finishes", async () => {
  const f = await fixture();
  const release = createSchedulerTestGate();
  f.invoke.mockImplementation(async () => {
    await release.waiting;
    return {
      text: JSON.stringify({ summary: "Earlier preferences." }),
      meta: {},
    };
  });
  try {
    expect(
      (await f.post({ command: { name: "compact", mode: "run" } })).status,
    ).toBe(200);
    const refused = await f.post({ text: "Concurrent chat message" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "session_busy" });
  } finally {
    release.open();
  }
});
