import { describe, expect, test } from "vitest";
import { eventTone, formatEventLabel } from "../../web-ui/app/lib/event-presentation.js";
import { hasCompletedConversationAnswer } from "../../web-ui/app/lib/conversation-final-answer.js";
import { isBlockedCompletion } from "../../web-ui/app/lib/completion-presentation.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const output = "The request could not be completed. Check your model connection.";
const completed = { type: "completed", requestId: "request-1", output, disposition: "blocked" };

describe("explicit blocked completion presentation", () => {
  test("a live blocked completion keeps output and terminal type but never announces success", () => {
    const h = createRealtimeContextHarness();
    h.controller.handle(completed);
    expect(h.assistant.text).toBe(output);
    expect(h.assistant.streaming).toBe(false);
    expect(hasCompletedConversationAnswer(h.assistant, h.state.events)).toBe(false);
    expect(h.state.events.at(-1)).toMatchObject({ type: "completed", disposition: "blocked", name: "Request blocked", tone: "failed" });
    expect(h.setMessageActivityStatus).toHaveBeenLastCalledWith("ABot request blocked.");
  });

  test("reload retains the blocked disposition and same timeline label and tone", async () => {
    const h = createPlanLifecycleHarness({
      sessionId: "session-1", messages: [{ id: "answer", role: "assistant", requestId: "request-1", content: output }],
      requests: [{ requestId: "request-1", status: "completed", finalState: { status: "completed", output, disposition: "blocked" },
        events: [{ ...completed, seqNo: 1, timestamp: 1000 }] }],
    });
    await h.conversationSession.openSession("session-1");
    expect(h.state.events.at(-1)).toMatchObject({ type: "completed", disposition: "blocked", name: "Request blocked", tone: "failed" });
    expect(h.state.messages.find((message) => message.role === "assistant")?.text).toBe(output);
    expect(formatEventLabel(h.state.events.at(-1)!)).toBe("Request blocked");
    expect(eventTone(h.state.events.at(-1)!)).toBe("failed");
  });

  test.each([undefined, "complete", "unknown"])("normal and legacy completions stay successful with disposition %s", (disposition) => {
    const h = createRealtimeContextHarness();
    h.controller.handle({ ...completed, disposition });
    expect(h.state.events).toEqual([]);
    expect(formatEventLabel({ ...completed, disposition })).toBe("Response ready");
    expect(eventTone({ ...completed, disposition })).toBe("done");
    expect(h.setMessageActivityStatus).toHaveBeenLastCalledWith("ABot response completed.");
    expect(h.assistant.text).toBe(output);
    expect(hasCompletedConversationAnswer(h.assistant, h.state.events)).toBe(true);
  });

  test("neither failure-shaped answer text nor unrelated events imply a blocked completion", () => {
    expect(isBlockedCompletion({ type: "completed", output })).toBe(false);
    expect(isBlockedCompletion({ type: "event", name: "tool.completed", disposition: "blocked" })).toBe(false);
    expect(isBlockedCompletion({ type: "event", name: "request.completed", disposition: "blocked" })).toBe(true);
  });
});
