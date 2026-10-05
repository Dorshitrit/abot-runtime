import type { ChatMessage } from "../../../model-gateway/types.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "./contracts.js";

/** A registered digest alone does not authorize a model-visible source message. */
export function readStoredSourceMessage(
  source: SemanticCompactionSource,
): ChatMessage {
  if (hash(source.content) !== source.sourceFingerprint)
    throw new Error("context_compaction_source_content_mismatch");
  let message: unknown;
  try {
    message = JSON.parse(source.content);
  } catch {
    throw new Error("context_compaction_source_message_invalid");
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new Error("context_compaction_source_message_invalid");
  const record = message as Record<string, unknown>;
  if (record.role !== "user")
    throw new Error("context_compaction_source_message_invalid");
  if (typeof record.content !== "string" || record.content.length === 0)
    throw new Error("context_compaction_source_message_invalid");
  if (Object.keys(record).some((key) => key !== "role" && key !== "content"))
    throw new Error("context_compaction_source_message_invalid");
  return record as unknown as ChatMessage;
}
