import { describe, expect, test } from "vitest";
import { failureResponseText } from "../../web-ui/app/lib/failure-presentation.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const rawError = "bridge_request_failed:500:private upstream body token=secret";
function failedRequest(response?: string) {
  return {
    requestId: "failed-request", status: "failed",
    finalState: { status: "failed", error: rawError },
    events: [{
      type: "failed", requestId: "failed-request", error: rawError, seqNo: 1, timestamp: 1000,
      ...(response ? { details: { stoppedResponse: response } } : {}),
    }],
  };
}
function failedPage(response?: string) {
  return {
    sessionId: "session-1",
    messages: [
      { id: "failed-user", role: "user", requestId: "failed-request", content: rawError, createdAt: 100 },
      { id: "failed-answer", role: "assistant", requestId: "failed-request", content: rawError, createdAt: 101 },
    ],
    requests: [failedRequest(response)],
  };
}
const currentAnswer = { id: "current-answer", role: "assistant", requestId: "current", content: "Existing answer", createdAt: 200 };

describe("paginated failure display copies", () => {
  test.each([
    ["older", undefined], ["older", "Saved actionable failure explanation."],
    ["newer", undefined], ["newer", "Saved actionable failure explanation."],
  ] as const)("history.load(%s) presents failure text from the page with saved response %s", async (direction, response) => {
    const initial = {
      sessionId: "session-1", messages: [currentAnswer],
      nextCursor: direction === "older" ? "older-page" : null,
      newerCursor: direction === "newer" ? "newer-page" : null,
      requests: [{ requestId: "current", status: "completed", events: [], finalState: { status: "completed", output: "Existing answer" } }],
    };
    const page = failedPage(response);
    const original = structuredClone(page);
    const h = createPlanLifecycleHarness(initial);
    await h.conversationSession.openSession("session-1");
    h.client.loadSession.mockResolvedValueOnce(page);
    await h.conversationSession.history.load(direction);
    const expected = failureResponseText(page.requests[0]!.events[0]);
    expect(h.state.messages.find((message) => message.id === "failed-answer")?.text).toBe(expected);
    expect(h.state.messages.find((message) => message.id === "failed-user")?.text).toBe(rawError);
    expect(h.state.messages.find((message) => message.id === "current-answer")?.text).toBe("Existing answer");
    expect(h.state.events.find((event) => event.requestId === "failed-request")?.summary).toBe(expected);
    expect(page).toEqual(original);
    expect(h.client.loadSession).toHaveBeenLastCalledWith("session-1", "dev", { cursor: direction + "-page" });
  });

  test("a request split across pages is presented even when its event snapshot was already restored", async () => {
    const response = "The saved model connection was unavailable.";
    const request = failedRequest(response);
    const initial = {
      sessionId: "session-1", nextCursor: "older-page",
      messages: [{ id: "request-user", role: "user", requestId: "failed-request", content: "Question", createdAt: 100 }],
      requests: [request],
    };
    const page = failedPage(response);
    const original = structuredClone({ initial, page });
    const h = createPlanLifecycleHarness(initial);
    await h.conversationSession.openSession("session-1");
    const eventCount = h.state.events.length;
    h.client.loadSession.mockResolvedValueOnce(page);
    await h.conversationSession.history.load("older");
    expect(h.state.messages.find((message) => message.id === "failed-answer")?.text).toBe(response);
    expect(h.state.events).toHaveLength(eventCount);
    expect({ initial, page }).toEqual(original);
  });
});
