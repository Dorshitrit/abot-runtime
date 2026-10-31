import { describe, expect, test } from "vitest";
import { failureResponseText } from "../../web-ui/app/lib/failure-presentation.js";
import { presentFailedResponseHistory } from "../../web-ui/app/lib/failed-response-history.js";
import { formatEventDetail } from "../../web-ui/app/lib/event-presentation.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const privateBody = "private upstream body with token=secret-value";
const legacyError = "bridge_request_failed:500:" + privateBody;

describe("request failure presentation", () => {
  test("a non-cancelled live failure displays the exact persisted explanation", () => {
    const h = createRealtimeContextHarness();
    const response = "Cannot reach your configured model. Check its connection.";
    const event = {
      type: "failed", requestId: "request-1", error: legacyError,
      details: { stoppedResponse: response },
    };
    h.controller.handle(event);
    expect(h.assistant.text).toBe(response);
    expect(h.assistant.streaming).toBe(false);
    expect(h.state.events.at(-1)?.summary).toBe(response);
  });

  test.each([
    legacyError, "bridge_raw_failed:404:" + privateBody,
    "model_stream_error: " + privateBody, "model_provider_failure", "no stream", "fetch failed",
  ])("legacy transport failure remains actionable without revealing provider body: %s", (error) => {
    const h = createRealtimeContextHarness();
    const event = { type: "failed", requestId: "request-1", error };
    h.controller.handle(event);
    expect(h.assistant.text).toContain("configured model");
    expect(h.assistant.text).toContain("Check the model connection");
    expect(h.assistant.text).not.toContain(privateBody);
    expect(h.assistant.text).not.toContain("Ollama");
    expect(h.state.events.at(-1)?.summary).toBe(h.assistant.text);
    expect(formatEventDetail(event)).toBe(h.assistant.text);
  });

  test("ordinary human-readable errors and cancellation retain their distinct semantics", () => {
    const h = createRealtimeContextHarness();
    h.controller.handle({ type: "failed", requestId: "request-1", error: "Select a model before sending." });
    expect(h.assistant.text).toBe("Select a model before sending.");
    const stopped = createRealtimeContextHarness();
    stopped.assistant.text = "Partial answer";
    stopped.controller.handle({ type: "failed", requestId: "request-1", error: "request_cancelled" });
    expect(stopped.assistant.text).toBe("Partial answer\n\n_Response stopped._");
    const saved = createRealtimeContextHarness();
    saved.controller.handle({
      type: "failed", requestId: "request-1", error: "request_cancelled",
      details: { stoppedResponse: "I stopped the task at your request." },
    });
    expect(saved.assistant.text).toBe("I stopped the task at your request.");
    expect(failureResponseText({ error: legacyError, details: { stoppedResponse: "   " } }))
      .toContain("configured model");
  });

  test.each([undefined, "Saved user-facing explanation."])("reload matches live failure presentation with recorded response %s", async (persisted) => {
    const terminal = {
      type: "failed", requestId: "request-1", error: legacyError,
      ...(persisted ? { details: { stoppedResponse: persisted } } : {}),
    };
    const payload = {
      sessionId: "session-1",
      messages: [
        { id: "user", role: "user", content: "Read my file", requestId: "request-1" },
        { id: "error", role: "assistant", content: legacyError, requestId: "request-1" },
      ],
      requests: [{
        requestId: "request-1", status: "failed", finalState: { status: "failed", error: legacyError },
        events: [{ ...terminal, seqNo: 1, timestamp: 1000 }],
      }],
    };
    const original = structuredClone(payload);
    const h = createPlanLifecycleHarness(payload);
    await h.conversationSession.openSession("session-1");
    expect(h.state.messages.find((message) => message.role === "assistant")?.text)
      .toBe(failureResponseText(terminal));
    expect(h.state.events.at(-1)?.summary).toBe(failureResponseText(terminal));
    expect(payload).toEqual(original);
  });

  test("historical display projection preserves completed answers, user text and approval messages", () => {
    const messages = [
      { role: "assistant", requestId: "complete", text: legacyError },
      { role: "user", requestId: "failed", text: legacyError },
      { role: "assistant", requestId: "failed", kind: "tool_approval_request", text: legacyError },
      { role: "assistant", requestId: "failed", kind: "user_interaction", text: "Established progress" },
      { role: "assistant", requestId: "failed", text: "Saved explanation" },
    ];
    const original = structuredClone(messages);
    presentFailedResponseHistory(messages, [
      { requestId: "complete", status: "completed", finalState: { error: legacyError } },
      { requestId: "failed", status: "failed", finalState: { error: legacyError } },
    ]);
    expect(messages).toEqual(original);
  });
});
