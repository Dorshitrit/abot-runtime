import { describe, expect, test } from "vitest";
import { hasCompletedConversationAnswer } from "../../web-ui/app/lib/conversation-final-answer.js";

const answer = { role: "assistant", requestId: "request-1", text: "The file is ready.", streaming: false };
const terminal = (type: string, requestId = "request-1") => ({ type, requestId });

describe("work timeline final answer boundary", () => {
  test("collapses for a saved final reply or a completed live response", () => {
    expect(hasCompletedConversationAnswer(answer)).toBe(true);
    expect(hasCompletedConversationAnswer(answer, [terminal("completed")])).toBe(true);
  });

  test.each([
    { ...answer, streaming: true },
    { ...answer, kind: "tool_approval_request" },
    { ...answer, kind: "user_interaction" },
    { ...answer, text: "" },
    { ...answer, role: "user" },
  ])("does not collapse before a final reply: %j", (message) => {
    expect(hasCompletedConversationAnswer(message, [terminal("completed")])).toBe(false);
  });

  test("keeps failed and deliberately stopped work inspectable", () => {
    expect(hasCompletedConversationAnswer(answer, [terminal("failed")])).toBe(false);
    expect(hasCompletedConversationAnswer({ ...answer, text: "Response stopped." }, [
      { requestId: "request-1", eventName: "request.failed", error: "request_cancelled" },
    ])).toBe(false);
    expect(hasCompletedConversationAnswer(answer, [terminal("failed", "request-2")])).toBe(true);
  });

  test("uses the current terminal outcome after a resumed request completes", () => {
    expect(hasCompletedConversationAnswer(answer, [terminal("failed"), terminal("completed")])).toBe(true);
  });
});
