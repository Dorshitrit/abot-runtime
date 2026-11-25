import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OpenAIResponsesStreamNormalizer, writeNormalizedOpenAIEvents } from "./stream-normalizer.js";
import { applyStreamLine } from "../../client-stream-parser.js";
import { createRuntimeEventBus } from "../../../runtime/events/runtime-emitter.js";
import { RequestActivationEvents } from "../../../runtime/request/approval-wait/activation-events.js";
import { createRequestCallbacks, type RequestPresentationSnapshot } from "../../../runtime/streaming/request-callbacks.js";
import { snapshotRequestHistory } from "../../../runtime/session/request-history.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../../../runtime/observability/debug-logger.js";
import { SessionService } from "../../../sessions/session-service.js";
import { createPlanLifecycleHarness } from "../../../runtime/__tests__/support/web-ui-plan-lifecycle-harness.js";
import { ContextElement } from "../../../runtime/__tests__/support/composer-context-window-dom.js";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../../web-ui/app/components/conversation-view.js";

const directories: string[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function summaryStream(callbacks: ReturnType<typeof createRequestCallbacks>) {
  const normalizer = new OpenAIResponsesStreamNormalizer({ reasoningSummary: true });
  let content = "";
  function consume(event: Record<string, unknown>) {
    writeNormalizedOpenAIEvents(normalizer.consume(event), {
      emit: (event) => {
        content = applyStreamLine(JSON.stringify(event), {
          onThinking: callbacks.onThinkingDelta,
          onToken: callbacks.onAnswerToken,
        }, content);
      },
    });
  }
  consume({ type: "response.output_item.added", output_index: 0, sequence_number: 0,
    item: { id: "reasoning-1", type: "reasoning", summary: [] } });
  consume({ type: "response.reasoning_summary_part.added", output_index: 0,
    item_id: "reasoning-1", summary_index: 0, sequence_number: 1,
    part: { type: "summary_text", text: "" } });
  return {
    consume,
    fragment: (index: number, delta: string) => consume({
      type: "response.reasoning_summary_text.delta", item_id: "reasoning-1",
      output_index: 0, summary_index: 0, sequence_number: index + 2, delta,
    }),
    content: () => content,
  };
}

async function durablePresentation() {
  const directory = await mkdtemp(join(tmpdir(), "openai-summary-lifecycle-"));
  directories.push(directory);
  const service = new SessionService({ sessionsDir: directory });
  await service.appendMessage("session-1", "user", "Inspect the request.", { requestId: "request-1" });
  const started = await service.requestLifecycle.startActivation("session-1", {
    requestId: "request-1", activationId: "activation-1", ownerEpoch: "owner-1",
  });
  if (!started.accepted) throw new Error(started.reason);
  const published: Record<string, unknown>[] = [];
  const owner = new RequestActivationEvents(service.requestLifecycle, started.current,
    { create: createRuntimeEventBus }, {
      send: (raw: string) => published.push(JSON.parse(raw)),
    } as unknown as WebSocket);
  const callbacks = createRequestCallbacks(owner.events, "request-1");
  return { directory, service, owner, published, callbacks, stream: summaryStream(callbacks) };
}

test("a summary burst coalesces durable writes and replay without changing answers or progress", async () => {
  const f = await durablePresentation();
  const append = vi.spyOn(f.service.requestLifecycle, "appendActivationEvent");
  const fragments = Array.from({ length: 1_024 }, (_, index) => `${index.toString(16)} `);
  fragments.forEach((fragment, index) => f.stream.fragment(index, fragment));
  await f.owner.events.drain();
  const summary = fragments.join("");
  expect(append).toHaveBeenCalledTimes(1);
  expect(f.published).toHaveLength(1);
  expect(f.published[0]).toMatchObject({ name: "thinking.delta", delta: summary, text: summary, seqNo: 1 });
  expect(f.callbacks.snapshot()).toEqual({ thinkingText: summary, answerText: "", thinkingTrace: [] });
  expect(f.callbacks.userInteractions.snapshot()).toBeUndefined();
  expect(f.stream.content()).toBe("");
  const replay = await f.service.getRequestReplayById("request-1", 0, "session-1");
  expect(replay?.events).toEqual(f.published);
  expect(JSON.stringify(replay?.events).length).toBeLessThan(summary.length * 3);
  expect((await f.service.getRequestReplayById("request-1", 1, "session-1"))?.events).toEqual([]);

  const ui = createPlanLifecycleHarness();
  ui.realtime.handle(f.published[0]);
  ui.realtime.handle(f.published[0]);
  expect(ui.state.messages.at(-1)).toMatchObject({ text: "", thinkingText: summary });
  expect(ui.state.lastSeqByRequest.get("request-1")).toBe(1);
  expect(ui.state.events).toHaveLength(0);
  expect(ui.state.messages).toHaveLength(2);
  expect(ui.drainQueuedComposerMessage).not.toHaveBeenCalled();

  await f.owner.commit((expected) => f.service.requestLifecycle.commitTerminal("session-1", {
    expected, commandId: "terminal", status: "completed", message: { content: "Exact final answer." },
  }));
  for (const event of f.published.slice(1)) ui.realtime.handle(event);
  expect(ui.state.messages.at(-1)).toMatchObject({ text: "Exact final answer.", thinkingText: summary });
  f.owner.events.dispose();
});

test("stored presentation resumes summaries without injecting them into model history", async () => {
  const f = await durablePresentation();
  f.stream.fragment(0, "First summary.");
  f.callbacks.onThinkingTrace({ step: "execution.decision", status: "completed", text: "First summary." });
  await f.owner.events.drain();
  const saved = await f.service.requestLifecycle.writeContinuation("session-1", {
    schema: "summary-presentation-test", version: 1, value: f.callbacks.snapshot(),
  });
  const restarted = new SessionService({ sessionsDir: f.directory });
  const restored = await restarted.requestLifecycle.readContinuation("session-1", saved) as RequestPresentationSnapshot;
  const resumed = createRequestCallbacks(f.owner.events, "request-1", restored);
  const continuation = summaryStream(resumed);
  continuation.fragment(0, " Continued summary.");
  await f.owner.events.drain();
  expect(f.published.at(-1)).toMatchObject({ text: "First summary. Continued summary.", delta: " Continued summary." });
  expect(resumed.getAnswerText()).toBe("");
  expect(resumed.userInteractions.snapshot()).toBeUndefined();
  expect(resumed.getThinkingTrace()).toEqual([{ sequence: 1, step: "execution.decision", status: "completed", text: "First summary." }]);
  await restarted.appendMessage("session-1", "assistant", "Final answer", { thinkingTrace: resumed.getThinkingTrace() });
  const session = (await restarted.getSessionById("session-1"))!;
  expect(session.messages.at(-1)?.thinkingTrace).toHaveLength(1);
  const history = snapshotRequestHistory(session);
  expect(history.map((message) => message.content)).toEqual(["Inspect the request.", "Final answer"]);
  expect(JSON.stringify(history)).not.toContain("summary");
  f.owner.events.dispose();
});

test("replayed summary survives reload and cancellation, and cannot cross session navigation", async () => {
  const f = await durablePresentation();
  f.stream.fragment(0, "Visible summary.");
  await f.owner.events.drain();
  const snapshot = await f.service.getSessionSnapshot("session-1");
  const ui = createPlanLifecycleHarness(snapshot as unknown as Record<string, unknown>, f.published);
  await ui.conversationSession.openSession("session-1");
  expect(ui.state.messages.at(-1)).toMatchObject({ thinkingText: "Visible summary." });
  ui.realtime.handle({ type: "failed", sessionId: "session-1", requestId: "request-1",
    error: "request_cancelled", eventSequence: 2, seqNo: 2 });
  expect(ui.state.messages.at(-1)).toMatchObject({ text: "Response stopped.", thinkingText: "Visible summary.", streaming: false });
  const previousCursor = ui.state.lastSeqByRequest.get("request-1");
  ui.client.loadSession.mockResolvedValue({ sessionId: "session-2", messages: [], requests: [] });
  await ui.conversationSession.openSession("session-2");
  ui.realtime.handle({ ...f.published[0], text: "Late previous summary", seqNo: 100 });
  expect(ui.state.messages).toEqual([]);
  expect(ui.state.lastSeqByRequest.get("request-1")).toBe(previousCursor);
  f.owner.events.dispose();
});

class SummaryElement extends ContextElement {
  scrollTop = 0;
  scrollHeight = 1_200;
  clientHeight = 300;
  open = false;
  inert = false;
  markupWrites = 0;
  set innerHTML(value: string) { this.markupWrites += 1; this.textContent = value; }
  get innerHTML() { return this.textContent; }
}

test("a summary burst renders once and pending rendering is cancelled on navigation", () => {
  vi.useFakeTimers();
  const ui = createPlanLifecycleHarness();
  const documentRoot = { activeElement: null, createElement: (tag: string) => new SummaryElement(tag) };
  const dom = { messagesList: new SummaryElement("div"), jumpToLatestButton: new SummaryElement("button") };
  const view = createConversationView({
    dom, documentRoot, viewport: { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() },
    getMessages: () => ui.state.messages, getActiveRequestId: () => ui.state.activeRequestId,
    getActivityForMessage: () => ({ events: [] }), getPendingApprovals: () => [],
    createApprovalCard: () => new SummaryElement("aside"), copyText: vi.fn(), notify: vi.fn(),
    showContextWindow: false,
  });
  view.render();
  const events = createRuntimeEventBus({ requestId: "request-1", ws: {
    send: (raw: string) => { ui.realtime.handle(JSON.parse(raw)); view.scheduleThinkingRender(); },
  } as unknown as WebSocket });
  const stream = summaryStream(createRequestCallbacks(events, "request-1"));
  const body = dom.messagesList.querySelector(".thinking-body") as SummaryElement;
  const initialWrites = body.markupWrites;
  for (let index = 0; index < 1_024; index += 1) stream.fragment(index, "x");
  expect(body.markupWrites).toBe(initialWrites);
  vi.advanceTimersByTime(180);
  expect(body.markupWrites).toBe(initialWrites + 1);
  expect(body.textContent).toContain("x".repeat(1_024));
  stream.fragment(1_024, "pending-old-session");
  view.reset();
  ui.state.messages = [{ id: "next-answer", role: "assistant", requestId: "next-request", text: "Another conversation", streaming: false }];
  view.render();
  vi.advanceTimersByTime(180);
  expect(dom.messagesList.textContent).not.toContain("pending-old-session");
  expect(body.markupWrites).toBe(initialWrites + 1);
  events.dispose();
});
