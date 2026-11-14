import { afterEach, expect, test, vi } from "vitest";
import { composerProductFixture } from "./__tests__/composer-product-fixture.js";
import { RUNTIME_COMMANDS } from "../../runtime/commands/catalog.js";
import { createRealtimeContextHarness } from "../../runtime/__tests__/support/realtime-context-harness.js";
// prettier-ignore
// @ts-expect-error Browser module.
import { isComposerCommand, matchingComposerCommands, resolveComposerCommand } from "../app/lib/composer-command.js";
// prettier-ignore
// @ts-expect-error Browser module.
import { rememberCommandRun, hasActiveCommandRun } from "../app/lib/command-runs.js";

afterEach(() => vi.unstubAllGlobals());

test("started feedback cannot resurrect a command after a terminal event", () => {
  const f = createRealtimeContextHarness();
  f.state.activeRequestId = "";
  f.state.messages = [];
  const started = {
    type: "event",
    name: "command.started",
    requestKind: "command",
    command: { name: "compact", mode: "run" },
    sessionId: "session-1",
    requestId: "command-1",
    seqNo: 1,
  };
  f.controller.handle(started);
  expect(f.state.activeRequestId).toBe("command-1");
  expect(f.setMessageActivityStatus).toHaveBeenLastCalledWith(
    "Compacting conversation history…",
    true,
  );
  f.controller.handle({
    ...started,
    type: "completed",
    name: "context.compaction.completed",
    outcome: "compacted",
    seqNo: 2,
  });
  f.controller.handle(started);
  expect(f.state.activeRequestId).toBe("");
  expect(f.state.messages).toHaveLength(0);
  expect(f.state.events).toHaveLength(2);
});

async function fixture() {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (url, input) => {
    if (String(url) === "/web-ui-state")
      return new Response(
        JSON.stringify({
          state: { version: 1, revision: 0, preferences: {}, queue: "" },
        }),
      );
    if (String(url).endsWith("/chat/commands"))
      return new Response(JSON.stringify({ commands: RUNTIME_COMMANDS }));
    requests.push(JSON.parse(String(input?.body)));
    return new Response(JSON.stringify({ requestId: "command-1" }));
  }) as typeof fetch;
  return { ...(await composerProductFixture({ fetchImpl })), requests };
}

test.each(["/compact", "/ compact"])(
  "%s submits metadata without chat messages",
  async (command) => {
    const f = await fixture();
    f.type(command);
    const result = await f.composer.submit.dispatch();
    expect(result.status).toBe("accepted");
    expect(f.requests).toEqual([
      expect.objectContaining({
        command: { name: "compact", mode: "run" },
        text: "",
        sessionId: "chat-1",
      }),
    ]);
    expect(f.state.messages).toHaveLength(0);
    expect(f.state.activeRequestId).toBe("command-1");
    expect(
      hasActiveCommandRun(f.state, {
        environmentId: "prod",
        sessionId: "chat-1",
      }),
    ).toBe(true);
  },
);

test("compact while running is refused with its draft retained, never sent as steering or queued", async () => {
  const f = await fixture();
  f.state.activeRequestId = "active";
  f.type("/compact");
  expect((await f.composer.submit.dispatch()).status).toBe("refused");
  expect(f.dom.composerInput.value).toBe("/compact");
  expect(f.requests).toHaveLength(0);
  expect(f.composer.queue.queuedCount()).toBe(0);
});

test("ordinary slash references and paths preserve the chat path", async () => {
  expect(isComposerCommand("Explain /compact")).toBe(false);
  expect(isComposerCommand("/workspace/file.ts")).toBe(false);
  const f = await fixture();
  f.type("Explain /compact");
  await f.composer.submit.dispatch();
  expect(f.requests[0]).not.toHaveProperty("command");
  expect(
    f.state.messages.some(
      (message: { role: string }) => message.role === "user",
    ),
  ).toBe(true);
});

test("filtering ranks names and per-command modes allow future steering commands", () => {
  expect(
    matchingComposerCommands("/com", RUNTIME_COMMANDS).map(
      (entry: { name: string }) => entry.name,
    ),
  ).toEqual(["compact"]);
  expect(matchingComposerCommands("/xyz", RUNTIME_COMMANDS)).toEqual([]);
  const future = [
    { name: "focus", description: "Change focus", modes: ["steer"] },
  ];
  expect(resolveComposerCommand("/focus", future, "active")).toEqual({
    name: "focus",
    mode: "steer",
    targetRequestId: "active",
  });
});

test("the command menu narrows as typed and keyboard acceptance fills the draft without submitting", async () => {
  const f = await fixture();
  f.type("/com");
  const menu = f.dom.composerForm.querySelector(".composer-command-menu");
  await vi.waitFor(() => expect(menu?.hidden).toBe(false));
  expect(menu.children).toHaveLength(1);
  expect(menu.children[0].textContent).toContain("/compact");
  const prevented = vi.fn(),
    stopped = vi.fn();
  f.dom.composerInput.dispatch("keydown", {
    key: "Enter",
    preventDefault: prevented,
    stopImmediatePropagation: stopped,
  });
  expect(f.dom.composerInput.value).toBe("/compact");
  expect(menu.hidden).toBe(true);
  expect(prevented).toHaveBeenCalledOnce();
  expect(stopped).toHaveBeenCalledOnce();
  expect(f.requests).toHaveLength(0);
  f.type("/unknown");
  await vi.waitFor(() => expect(menu.hidden).toBe(true));
});

test("Home submits a command through the shared composer without manufacturing a chat turn", async () => {
  const f = await fixture();
  f.showHome();
  f.type("/compact");
  await f.home.submit.dispatch();
  expect(f.requests[0]).toMatchObject({
    sessionId: "home-1",
    command: { name: "compact", mode: "run" },
  });
  expect(f.state.messages).toHaveLength(0);
});

test("a terminal command event creates no answer, handles replay once, and cannot resurrect on late acceptance", () => {
  const f = createRealtimeContextHarness();
  f.state.activeRequestId = "";
  f.state.messages = [];
  f.shouldAcceptMessage.mockReturnValue(false);
  const event = {
    type: "completed",
    requestKind: "command",
    requestId: "command-1",
    sessionId: "session-1",
    environment: "environment-1",
    name: "context.compaction.completed",
    command: { name: "compact", mode: "run" },
    outcome: "compacted",
    seqNo: 2,
  };
  f.controller.handle(event);
  f.controller.handle(event);
  expect(f.state.messages).toHaveLength(0);
  expect(f.state.events).toHaveLength(1);
  expect(
    rememberCommandRun(
      f.state,
      { environmentId: "environment-1", sessionId: "session-1" },
      "command-1",
    ),
  ).toBe(false);
  expect(f.renderMessages).not.toHaveBeenCalled();
  f.state.events = [];
  f.controller.recordEvent(event);
  expect(f.state.events).toHaveLength(1);
});

test("terminal events for a different environment or session cannot settle the visible run", () => {
  const f = createRealtimeContextHarness();
  const event = {
    type: "completed",
    requestKind: "command",
    requestId: "request-1",
    sessionId: "session-1",
    command: { name: "compact", mode: "run" },
    name: "context.compaction.completed",
  };
  f.controller.handle({ ...event, environment: "different" });
  f.controller.handle({
    ...event,
    environment: "environment-1",
    sessionId: "another-session",
  });
  expect(f.state.activeRequestId).toBe("request-1");
  expect(f.state.events).toHaveLength(0);
});
