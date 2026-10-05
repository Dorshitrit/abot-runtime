import { describe, expect, test, vi } from "vitest";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import {
  projectProactiveConversationStyle,
  readProactiveConversationStyle,
} from "../passive-learning/proactive/conversation-style-reference.js";

function message(id: string, changes: Record<string, unknown> = {}): SessionMessage {
  return { id, role: "user", content: id, createdAt: "2026-10-02T09:00:00.000Z", ...changes };
}
function session(messages: SessionMessage[]): SessionRecord {
  return { id: "spark-companion", kind: "spark", title: "Renamed companion",
    createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T09:00:00.000Z",
    lastAgentMode: "reasoning", messageCount: messages.length, messages };
}

describe("canonical proactive conversation style projection", () => {
  test("includes initial requests with absent source and explicit human steering in chronology", () => {
    const original = session([
      message("initial"),
      message("assistant", { role: "assistant", content: "Not a human sample" }),
      message("steering", { source: "user", requestId: "r1" }),
      message("later-request", { taskType: "development", attachments: [] }),
    ]);
    const before = structuredClone(original);
    expect(projectProactiveConversationStyle(original)).toMatchObject({
      sessionId: "spark-companion", totalCount: 3, omittedCount: 0,
      selection: "latest_retained_human_messages", order: "canonical_chronological",
      entries: [
        { messageId: "initial", content: "initial", truncated: false },
        { messageId: "steering", content: "steering", truncated: false },
        { messageId: "later-request", content: "later-request", truncated: false },
      ],
    });
    expect(original).toEqual(before);
    expect(projectProactiveConversationStyle(original)!.entries[2]).not.toHaveProperty("attachments");
  });

  test.each([
    { role: "assistant" }, { role: "system" }, { role: "tool" },
    { source: "request" }, { source: "agent_bridge" }, { source: "cron" },
    { source: "co_worker" }, { schedule: {} }, { cronJobId: "job" },
    { cronTitle: "Scheduled" }, { triggerType: "timer" },
    { grounding: "tool_observation" }, { observationMeta: {} },
    { observationContent: "Tool evidence" }, { kind: "terminal" },
    { initiative: {} }, { approvalRequest: {} }, { content: "  \n " },
  ])("excludes synthetic, scheduled, tool and nonhuman message %j", changes => {
    expect(projectProactiveConversationStyle(session([message("excluded", changes)]))).toBeUndefined();
  });

  test.each(["OK", "תמשיכי בבקשה באנגלית."])(
    "retains language continuity and explicit preference evidence without classifying %s in code",
    latest => {
      const texts = ["אשמח לדבר איתך בעברית ובצורה טבעית.", latest];
      const reference = projectProactiveConversationStyle(session(
        texts.map((content, index) => message(String(index), { content })),
      ))!;
      expect(reference.entries.map(entry => entry.content)).toEqual(texts);
      expect(reference).not.toHaveProperty("language");
    },
  );

  test("bounds the last three eligible samples without splitting Unicode or inventing omitted text", () => {
    const long = "🙂".repeat(1001);
    const original = session([
      message("old"), message("one"), message("two", { content: "Keep this exact text.\n" }),
      message("three", { content: long }), message("assistant", { role: "assistant" }),
    ]);
    const projected = projectProactiveConversationStyle(original)!;
    expect(projected).toMatchObject({
      totalCount: 4, omittedCount: 1, maxEntries: 3, maxExcerptCharacters: 1000,
      characterCounting: "unicode_code_points",
    });
    expect(projected.entries.map(entry => entry.messageId)).toEqual(["one", "two", "three"]);
    expect(projected.entries[1]!.content).toBe("Keep this exact text.\n");
    expect(projected.entries[2]).toMatchObject({
      content: "🙂".repeat(1000), originalCharacters: 1001, truncated: true,
      createdAt: original.messages[3]!.createdAt,
    });
    original.messages[3]!.content = "Changed after projection";
    expect(projected.entries[2]!.content).toBe("🙂".repeat(1000));
  });

  test("does not use a title, an unmarked reserved id or a different marked session as provenance", () => {
    const marked = session([message("human")]);
    for (const value of [
      null, { ...marked, kind: undefined }, { ...marked, id: "ordinary" },
      { ...marked, id: "ordinary", kind: undefined, title: "SPARK Chat" },
      { ...marked, messages: [] },
    ]) expect(projectProactiveConversationStyle(value)).toBeUndefined();
  });

  test("reads only the injected environment store without creating or scanning sessions", async () => {
    const first = { getSessionById: vi.fn(async () => session([message("first-environment")])) };
    const second = { getSessionById: vi.fn(async () => session([message("second-environment")])) };
    expect((await readProactiveConversationStyle(first))!.entries[0]!.content).toBe("first-environment");
    expect((await readProactiveConversationStyle(second))!.entries[0]!.content).toBe("second-environment");
    expect(first.getSessionById).toHaveBeenCalledExactlyOnceWith("spark-companion");
    expect(second.getSessionById).toHaveBeenCalledExactlyOnceWith("spark-companion");
    expect(await readProactiveConversationStyle(undefined)).toBeUndefined();
    expect(await readProactiveConversationStyle({ getSessionById: async () => null })).toBeUndefined();
    await expect(readProactiveConversationStyle({ getSessionById: async () => {
      throw new Error("canonical_session_read_failed");
    } })).rejects.toThrow("canonical_session_read_failed");
  });
});
