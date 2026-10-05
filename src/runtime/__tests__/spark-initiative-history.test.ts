import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "../../model-gateway/types.js";
import { SessionService } from "../../sessions/session-service.js";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import { projectRootSessionMemory } from "../context/session-memory/root-projection.js";
import { projectRequestContext } from "../context/request-context.js";
import { snapshotRequestHistory } from "../session/request-history.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const saved = {
  reason: "Private saved reason for the initiative.",
  handoffBrief: "Private background reserved for the explicit work-session handoff.",
};
function initiative(index: number): SessionMessage {
  return {
    id: "initiative:" + index, role: "assistant", source: "co_worker", grounding: "conversation",
    createdAt: new Date(index * 1000).toISOString(), content: "Original suggestion " + index,
    initiative: { kind: "proactive_proposal_v1", proposalId: String(index), ...saved,
      sources: [{ kind: "memory", id: "opaque-source-" + index, version: "1" }] },
  };
}
function session(messages: SessionMessage[]): SessionRecord {
  return { id: "spark-companion", kind: "spark", title: "SPARK", createdAt: new Date(0).toISOString(),
    updatedAt: new Date(100000).toISOString(), lastAgentMode: "reasoning", messageCount: messages.length, messages };
}
function memory(record: SessionRecord) {
  return createRequestSessionMemory({ sessionId: record.id, session: record,
    compactor: { compact: async () => { throw new Error("unexpected_compaction"); } },
    repository: { compareAndSwapSessionMemoryCheckpoint: async () => { throw new Error("unexpected_checkpoint"); } },
  });
}
function modelHistory(record: SessionRecord, prompt: string) {
  const request = { sessionKind: record.kind, historyMessages: snapshotRequestHistory(record), sessionMemory: memory(record) };
  return projectRequestContext({ ...projectRootSessionMemory(request), instructions: "Root policy", prompt,
    budget: { contextWindowTokens: 50000, outputReserveTokens: 1000, safetyReserveTokens: 1000, attachmentReserveTokens: 0 } });
}
function assertNoInitiativeMetadata(messages: readonly ChatMessage[]) {
  expect(messages.every((message) => Object.keys(message).sort().join(",") === "content,role")).toBe(true);
  for (const { content } of messages) {
    expect(content).not.toContain(saved.reason);
    expect(content).not.toContain(saved.handoffBrief);
    expect(content).not.toContain("opaque-source-");
  }
}

describe("ordinary initiative history", () => {
  test("preserves adjacent assistant messages exactly once in canonical order without a separate context block", () => {
    const createdAt = new Date(0).toISOString();
    const record = session([
      { id: "old-user", role: "user", content: "Earlier question", requestId: "old", createdAt },
      { id: "old-assistant", role: "assistant", content: "Earlier answer", requestId: "old", createdAt },
      initiative(1), initiative(2),
    ]);
    const prompt = "A completely unrelated current request.";
    const projection = modelHistory(record, prompt);
    expect(projection.messages).toEqual([
      { role: "system", content: "Root policy" },
      ...record.messages.map(({ role, content }) => ({ role, content })),
      { role: "user", content: prompt },
    ]);
    expect(projection.budget.parts.priorConversationInputTokens).toBe(0);
    assertNoInitiativeMetadata(projection.messages);
    expect(modelHistory({ ...record, kind: undefined }, prompt)).toEqual(projection);
  });

  test("standalone assistant history does not require saved provenance or a preceding user message", () => {
    const original = initiative(1);
    const record = session([{ ...original, initiative: { ...original.initiative!, handoffBrief: undefined } }]);
    const prompt = "What did you suggest?";
    const projected = modelHistory(record, prompt);
    expect(projected.messages).toEqual([
      { role: "system", content: "Root policy" },
      { role: "assistant", content: original.content },
      { role: "user", content: prompt },
    ]);
    assertNoInitiativeMetadata(projected.messages);
  });

  test("the root helper forwards ordinary history when no session-memory owner is present", () => {
    const record = session([initiative(1)]);
    const historyMessages = snapshotRequestHistory(record);
    const request = { sessionKind: record.kind, historyMessages };
    expect(projectRootSessionMemory(request)).toEqual({ historyMessages, priorConversationMessages: [] });
  });

  test("file-backed restart preserves exact history and handoff metadata while clear removes model-visible history", async () => {
    const parent = join(process.cwd(), ".codex/artifacts/spark-initiative-history-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "session-")); roots.push(directory);
    const service = new SessionService({ sessionsDir: directory });
    const original = initiative(1);
    await service.appendAssistantInitiative("spark-companion", {
      title: "Saved initiative", content: original.content, initiative: original.initiative!,
    });
    const first = (await service.getSessionById("spark-companion"))!;
    const expected = modelHistory(first, "An unrelated request.");
    const restarted = new SessionService({ sessionsDir: directory });
    const restored = (await restarted.getSessionById(first.id))!;
    expect(restored.messages[0]!.initiative).toEqual(original.initiative);
    expect(modelHistory(restored, "An unrelated request.")).toEqual(expected);
    assertNoInitiativeMetadata(expected.messages);
    await restarted.clearSessionMessages(first.id);
    const cleared = (await restarted.getSessionById(first.id))!;
    expect(cleared.kind).toBe("spark");
    expect(modelHistory(cleared, "A fresh request.").messages).toEqual([
      { role: "system", content: "Root policy" }, { role: "user", content: "A fresh request." },
    ]);
  });
});
