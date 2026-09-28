import type { SessionMessage, SessionRecord } from "./types.js";
import { assertValidSessionId } from "./record/rules.js";
import { deleteSessionFile, ensureSessionsDir, loadSessionFile, saveSessionFile } from "./session-store.js";

export type AssistantInitiative = Readonly<{
  kind: "proactive_proposal_v1";
  proposalId: string;
  reason: string;
  sources: readonly Readonly<{ kind: "candidate" | "memory"; id: string; version: string }>[];
}>;

export type CreateAssistantConversationInput = Readonly<{
  title: string;
  content: string;
  initiative: AssistantInitiative;
  /** In-process guard, checked before and after commit; invalid new records are rolled back. */
  assertCurrent?(): void;
}>;

/** Called under the same per-session mutation queue as edits and deletion. */
export async function createAssistantConversationRecord(options: {
  directory: string; sessionId: string; input: CreateAssistantConversationInput; now: Date;
}): Promise<SessionRecord> {
  const { sessionId, input } = options;
  input.assertCurrent?.();
  assertValidSessionId(sessionId);
  assertAssistantInitiative(input);
  await ensureSessionsDir(options.directory);
  const existing = await loadSessionFile(options.directory, sessionId);
  input.assertCurrent?.();
  if (existing) {
    const matches = existing.messages.some((message) => message.initiative?.proposalId === input.initiative.proposalId);
    if (!matches) throw new Error("assistant_conversation_identity_conflict");
    return existing;
  }
  const timestamp = options.now.toISOString();
  const record: SessionRecord = {
    id: sessionId, title: input.title, createdAt: timestamp, updatedAt: timestamp,
    lastAgentMode: "reasoning", messageCount: 1,
    messages: [{ id: `initiative:${input.initiative.proposalId}`, role: "assistant", content: input.content,
      source: "co_worker", grounding: "conversation", createdAt: timestamp, initiative: input.initiative }],
  };
  await saveSessionFile(options.directory, record, input.assertCurrent);
  try { input.assertCurrent?.(); }
  catch (error) {
    // The per-session mutation queue still excludes edits and deletion here.
    await deleteSessionFile(options.directory, sessionId);
    throw error;
  }
  return record;
}

export function isAssistantInitiativeMessage(message: SessionMessage): boolean {
  if (message.role !== "assistant" || message.source !== "co_worker") return false;
  if (message.initiative?.kind !== "proactive_proposal_v1") return false;
  return typeof message.initiative.proposalId === "string" && message.initiative.proposalId.length > 0;
}

function assertAssistantInitiative(input: CreateAssistantConversationInput): void {
  if (!input.title.trim() || input.title.length > 160) throw new Error("assistant_initiative_title_invalid");
  if (!input.content.trim() || input.content.length > 4000) throw new Error("assistant_initiative_content_invalid");
  if (input.initiative.kind !== "proactive_proposal_v1" || !input.initiative.proposalId.trim()) throw new Error("assistant_initiative_binding_invalid");
  if (!input.initiative.reason.trim() || input.initiative.reason.length > 1000) throw new Error("assistant_initiative_reason_invalid");
  if (!input.initiative.sources.length || input.initiative.sources.length > 12) throw new Error("assistant_initiative_sources_invalid");
  for (const source of input.initiative.sources) {
    if (source.kind !== "candidate" && source.kind !== "memory") throw new Error("assistant_initiative_sources_invalid");
    if (!source.id.trim() || source.id.length > 160 || !source.version.trim() || source.version.length > 160)
      throw new Error("assistant_initiative_sources_invalid");
  }
}
