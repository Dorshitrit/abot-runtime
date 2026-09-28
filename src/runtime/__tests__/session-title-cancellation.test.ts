import { expect, test } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import { shouldGenerateSessionTitle } from "../session/session-title.js";

test.each([
  { outcome: "cancelled", title: "session", expected: true },
  { outcome: "cancelled", title: "My title", expected: false },
  { outcome: "failed", title: "session", expected: false },
  { outcome: "streaming", title: "session", expected: false },
  { outcome: "completed", title: "session", expected: false },
] as const)(
  "title eligibility after $outcome preserves '$title'",
  ({ outcome, title, expected }) => {
    const session: SessionRecord = {
      id: "session",
      title,
      createdAt: "2026-09-25T00:00:00Z",
      updatedAt: "2026-09-25T00:00:01Z",
      lastAgentMode: "reasoning",
      messageCount: 1,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Research a topic.",
          requestId: "request",
          createdAt: "2026-09-25T00:00:00Z",
        },
      ],
      requests: [
        {
          requestId: "request",
          sessionId: "session",
          status: outcome === "cancelled" ? "failed" : outcome,
          createdAt: "2026-09-25T00:00:00Z",
          updatedAt: "2026-09-25T00:00:01Z",
          lastSeqNo: 1,
          events: [
            {
              requestId: "request",
              seqNo: 1,
              timestamp: "2026-09-25T00:00:01Z",
              type: "failed",
              payload: {
                error:
                  outcome === "cancelled"
                    ? "request_cancelled"
                    : "provider_error",
              },
            },
          ],
        },
      ],
    };
    expect(shouldGenerateSessionTitle(session)).toBe(expected);
    session.messages.push({
      ...session.messages[0]!,
      id: "assistant-1",
      role: "assistant",
      content: "A persisted response.",
    });
    expect(shouldGenerateSessionTitle(session)).toBe(expected);
    // A new pending message must not inherit a different request's cancellation.
    session.messages.push({
      ...session.messages[0]!,
      id: "user-2",
      requestId: "pending",
    });
    expect(shouldGenerateSessionTitle(session)).toBe(false);
  },
);
