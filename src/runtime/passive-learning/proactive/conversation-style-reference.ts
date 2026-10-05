import type { ChatMessage } from "../../../model-gateway/types.js";
import { isSparkSession, SPARK_SESSION_ID } from "../../../sessions/spark-session.js";
import type { SessionMessage, SessionRecord } from "../../../sessions/types.js";
import type { SessionStore } from "../../ports.js";

const MAX_MESSAGES = 3;
const MAX_EXCERPT_CHARACTERS = 1000;

export type ProactiveConversationStyleReference = Readonly<{
  kind: "co_worker_proactive_conversation_style_v1";
  authority: "passive_reference";
  provenance: "canonical_marked_spark_session_user_messages";
  purpose: "language_and_style_only";
  applicability: "eligible_proposal_title_and_message_only";
  presenceEffect: "does_not_add_user_intent_pending_work_actions_sources_or_timing";
  sessionId: typeof SPARK_SESSION_ID;
  selection: "latest_retained_human_messages";
  order: "canonical_chronological";
  characterCounting: "unicode_code_points";
  maxEntries: number;
  maxExcerptCharacters: number;
  totalCount: number;
  omittedCount: number;
  entries: readonly Readonly<{
    messageId: string;
    createdAt: string;
    content: string;
    originalCharacters: number;
    truncated: boolean;
  }>[];
}>;

/** Ordinary initial requests omit source; persisted user steering sets it explicitly. */
function isHumanConversationMessage(message: SessionMessage): boolean {
  if (message.role !== "user") return false;
  if (message.source !== undefined && message.source !== "user") return false;
  if (message.schedule || message.cronJobId || message.cronTitle || message.triggerType) return false;
  if (message.grounding === "tool_observation" || message.observationMeta || message.observationContent) return false;
  if (message.kind || message.initiative || message.approvalRequest) return false;
  return message.content.trim().length > 0;
}

export function projectProactiveConversationStyle(
  session: SessionRecord | null,
): ProactiveConversationStyleReference | undefined {
  if (!session || session.id !== SPARK_SESSION_ID || !isSparkSession(session)) return undefined;
  const humanMessages = session.messages.filter(isHumanConversationMessage);
  if (!humanMessages.length) return undefined;
  const entries = humanMessages.slice(-MAX_MESSAGES).map(message => {
    const characters = Array.from(message.content);
    return Object.freeze({
      messageId: message.id,
      createdAt: message.createdAt,
      content: characters.slice(0, MAX_EXCERPT_CHARACTERS).join(""),
      originalCharacters: characters.length,
      truncated: characters.length > MAX_EXCERPT_CHARACTERS,
    });
  });
  return Object.freeze({
    kind: "co_worker_proactive_conversation_style_v1",
    authority: "passive_reference",
    provenance: "canonical_marked_spark_session_user_messages",
    purpose: "language_and_style_only",
    applicability: "eligible_proposal_title_and_message_only",
    presenceEffect: "does_not_add_user_intent_pending_work_actions_sources_or_timing",
    sessionId: SPARK_SESSION_ID,
    selection: "latest_retained_human_messages",
    order: "canonical_chronological",
    characterCounting: "unicode_code_points",
    maxEntries: MAX_MESSAGES,
    maxExcerptCharacters: MAX_EXCERPT_CHARACTERS,
    totalCount: humanMessages.length,
    omittedCount: humanMessages.length - entries.length,
    entries: Object.freeze(entries),
  });
}

export async function readProactiveConversationStyle(
  sessions: Pick<SessionStore, "getSessionById"> | undefined,
): Promise<ProactiveConversationStyleReference | undefined> {
  if (!sessions) return undefined;
  return projectProactiveConversationStyle(await sessions.getSessionById(SPARK_SESSION_ID));
}

export function proactiveConversationStyleMessages(
  reference: ProactiveConversationStyleReference | undefined,
): ChatMessage[] {
  if (!reference) return [];
  return [{ role: "system", content: JSON.stringify(reference) }];
}
