import type { ChatMessage } from "../../model-gateway/types.js";
import type { LongTermMemoryRecord } from "./contracts.js";

export const LONG_TERM_MEMORY_MESSAGE_KIND =
  "runtime_long_term_memory_reference_v1" as const;

const MAX_PROJECTED_MEMORIES = 6;
const MAX_PROJECTED_CHARACTERS = 6_000;

export function projectLongTermMemoryMessage(
  rankedRecords: readonly LongTermMemoryRecord[],
): ChatMessage | undefined {
  const projection = selectWithinBudget(rankedRecords);
  if (!projection) {
    return undefined;
  }
  return Object.freeze({
    role: "system" as const,
    content: projection.serialized,
  });
}

function selectWithinBudget(
  records: readonly LongTermMemoryRecord[],
): Readonly<{ serialized: string }> | undefined {
  const selected: LongTermMemoryRecord[] = [];
  let serialized: string | undefined;
  for (const record of records) {
    const exceedsCount = selected.length >= MAX_PROJECTED_MEMORIES;
    if (exceedsCount) {
      break;
    }
    const candidate = serializeProjection([...selected, record]);
    if (candidate.length > MAX_PROJECTED_CHARACTERS) {
      continue;
    }
    selected.push(record);
    serialized = candidate;
  }
  return serialized ? Object.freeze({ serialized }) : undefined;
}

function serializeProjection(records: readonly LongTermMemoryRecord[]): string {
  return JSON.stringify({
    kind: LONG_TERM_MEMORY_MESSAGE_KIND,
    authority: "passive_reference",
    purpose: "support_personalized_terminal_response_authoring",
    memories: records.map(({ content, tags }) => ({ content, tags })),
    presenceEffect:
      "reference_only_not_current_user_intent_assignment_action_authority_or_completion_evidence",
  });
}
