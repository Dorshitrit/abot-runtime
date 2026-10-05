import { assertAssistantInitiative, type CreateAssistantConversationInput } from "./assistant-initiative.js";
import { saveDurableSessionFile } from "./durable-session-commit.js";
import { deleteSessionFile, ensureSessionsDir, loadSessionFile } from "./session-store.js";
import { assertValidSessionId } from "./record/rules.js";
import { assertSessionKindUnchanged, sessionKindCreationFields } from "./spark-session.js";
import type { SessionRecord } from "./types.js";

/** Covers the proactive owner's complete retained receipt window. Never model context. */
export const MAX_ASSISTANT_INITIATIVE_RECEIPTS = 100;

/** Pure append shared by storage adapters; proposal identity is the replay key. */
export function appendSparkInitiativeRecord(
  existing: SessionRecord | null,
  sessionId: string,
  input: CreateAssistantConversationInput,
  now: Date,
): SessionRecord {
  input.assertCurrent?.();
  assertValidSessionId(sessionId);
  assertAssistantInitiative(input);
  const identity = sessionKindCreationFields(sessionId, { kind: "spark" });
  if (existing) assertSessionKindUnchanged(existing, "spark");
  if (hasSavedInitiative(existing, input.initiative.proposalId)) return existing!;
  const timestamp = now.toISOString();
  const session: SessionRecord = existing ?? {
    id: sessionId, ...identity, createdAt: timestamp, updatedAt: timestamp,
    lastAgentMode: "reasoning", messageCount: 0, messages: [],
  };
  const messages: SessionRecord["messages"] = [...session.messages, {
    id: `initiative:${input.initiative.proposalId}`, role: "assistant", content: input.content,
    source: "co_worker", grounding: "conversation", createdAt: timestamp, initiative: input.initiative,
  }];
  const assistantInitiativeReceipts = [...(session.assistantInitiativeReceipts ?? []), input.initiative.proposalId]
    .slice(-MAX_ASSISTANT_INITIATIVE_RECEIPTS);
  return { ...session, messages, messageCount: messages.length, updatedAt: timestamp, assistantInitiativeReceipts };
}

function hasSavedInitiative(session: SessionRecord | null, proposalId: string): boolean {
  if (!session) return false;
  if (session.assistantInitiativeReceipts?.includes(proposalId)) return true;
  return hasVisibleAssistantInitiative(session, proposalId);
}

export function hasVisibleAssistantInitiative(session: SessionRecord, proposalId: string): boolean {
  return session.messages.some((message) => message.initiative?.proposalId === proposalId);
}

/** Caller holds the canonical session mutation queue across commit and rollback. */
export async function appendAssistantInitiativeRecord(options: {
  directory: string; sessionId: string; input: CreateAssistantConversationInput; now: Date;
}): Promise<SessionRecord> {
  options.input.assertCurrent?.();
  assertValidSessionId(options.sessionId);
  await ensureSessionsDir(options.directory);
  const existing = await loadSessionFile(options.directory, options.sessionId);
  const record = appendSparkInitiativeRecord(existing, options.sessionId, options.input, options.now);
  if (record === existing) return record;
  await saveDurableSessionFile(options.directory, record, options.input.assertCurrent);
  try { options.input.assertCurrent?.(); }
  catch (error) {
    await restorePreInitiativeRecord(options.directory, options.sessionId, existing);
    throw error;
  }
  return record;
}

async function restorePreInitiativeRecord(
  directory: string,
  sessionId: string,
  existing: SessionRecord | null,
): Promise<void> {
  if (existing) return saveDurableSessionFile(directory, existing);
  await deleteSessionFile(directory, sessionId);
}
