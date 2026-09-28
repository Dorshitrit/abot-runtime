import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import { projectRequestSource } from "../context/request-source.js";
import { snapshotRequestHistory } from "../session/request-history.js";
import { captureApprovalSnapshotData } from "../request/approval-wait/snapshot-data.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function message(
  id: string,
  role: SessionMessage["role"],
  content: string,
  kind?: SessionMessage["kind"],
  requestId = "prior",
): SessionMessage {
  return {
    id,
    role,
    content,
    kind,
    requestId,
    createdAt: "2026-09-28T10:00:00Z",
  };
}

function conversation(messages: SessionMessage[]): SessionRecord {
  return {
    id: "conversation",
    title: "History",
    lastAgentMode: "reasoning",
    createdAt: "2026-09-28T10:00:00Z",
    updatedAt: "2026-09-28T10:00:00Z",
    messageCount: messages.length,
    messages,
  };
}

function payloadSource(
  historyMessages: ReturnType<typeof snapshotRequestHistory>,
) {
  return projectRequestSource({
    requestId: "follow-up",
    prompt: "Save the comparison in a new file.",
    modelStep: "tool_payload.raw",
    callId: "payload",
    historyMessages,
  });
}

test("payload history selects the final reply across approvals, session reload and continuation persistence", async () => {
  const record = conversation([
    message("user", "user", "Compare the two alternatives."),
    message(
      "approval-1",
      "assistant",
      "Read the source?",
      "tool_approval_request",
    ),
    message(
      "approval-2",
      "assistant",
      "Search for evidence?",
      "tool_approval_request",
    ),
    message(
      "answer",
      "assistant",
      "The exact comparison\nwith its supporting details.",
      "terminal",
    ),
  ]);
  const root = join(
    process.cwd(),
    ".codex/artifacts/approval-context-review-20260928",
  );
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "history-"));
  directories.push(directory);
  await writeFile(join(directory, "conversation.json"), JSON.stringify(record));
  const restarted = new SessionService({ sessionsDir: directory });
  const restored = (await restarted.getSessionById("conversation"))!;
  expect(
    restored.messages.filter((item) => item.kind === "tool_approval_request"),
  ).toHaveLength(2);
  for (const source of [record, restored]) {
    const historyMessages = snapshotRequestHistory(source);
    const seed = captureApprovalSnapshotData({ historyMessages });
    const reference = await restarted.requestLifecycle.writeContinuation(
      "conversation",
      {
        schema: "history-test",
        version: 1,
        value: { seed },
      },
    );
    const resumed = (await restarted.requestLifecycle.readContinuation(
      "conversation",
      reference,
    )) as { seed: typeof seed };
    const view = payloadSource(resumed.seed.historyMessages);
    expect(view.precedingTurn).toEqual({
      user: {
        id: "user",
        content: record.messages[0].content,
        requestId: "prior",
      },
      assistant: {
        id: "answer",
        content: record.messages[3].content,
        requestId: "prior",
      },
    });
    expect(view.currentRequest).toBe("Save the comparison in a new file.");
    expect(resumed.seed.historyMessages.map((item) => item.id)).toEqual([
      "user",
      "answer",
    ]);
  }
});

test("an approval alone cannot complete a turn or replace the last settled answer", () => {
  const record = conversation([
    message("old-user", "user", "Earlier question", undefined, "old"),
    message("old-answer", "assistant", "Earlier answer", undefined, "old"),
    message("user", "user", "Pending question"),
    message("approval", "assistant", "Approve?", "tool_approval_request"),
  ]);
  expect(
    payloadSource(snapshotRequestHistory(record)).precedingTurn?.assistant.id,
  ).toBe("old-answer");
});

test("ordinary history and tool-observation filtering retain their existing projection", () => {
  const record = conversation([
    message("user", "user", "  Original question  "),
    message("answer", "assistant", "  Original answer\n  "),
    {
      ...message("observation", "assistant", "Tool data"),
      grounding: "tool_observation",
    },
  ]);
  const before = record.messages.map(({ kind: _kind, ...item }) => item);
  expect(snapshotRequestHistory(record)).toEqual(before);
  expect(payloadSource(snapshotRequestHistory(record))).toEqual(
    payloadSource(before),
  );
});
