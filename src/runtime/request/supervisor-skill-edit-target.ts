import type { KnowledgeSkillDocument } from "../knowledge-skills/store.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";

type PersonalEditTarget = KnowledgeSkillDocument & Readonly<{ source: "personal"; revision: number }>;

/** Resolve the captured document, never a newer Store value, for one accepted edit. */
export function findCapturedPersonalSkillEditTarget(
  head: RoleCallLedgerHead,
  skillId: string,
  expectedRevision?: number,
): PersonalEditTarget | undefined {
  for (const read of [...(head.state.skillReads ?? [])].reverse()) {
    if (read.callId !== head.state.rootCallId) continue;
    if (read.operation !== "read_skills" || read.result.outcome !== "completed") continue;
    const document = read.result.skills.find((candidate) => candidate.skillId === skillId);
    if (!document) continue;
    if (!isPersonalEditTarget(document)) return undefined;
    if (expectedRevision !== undefined && document.revision !== expectedRevision) return undefined;
    return document;
  }
  return undefined;
}

function isPersonalEditTarget(document: KnowledgeSkillDocument): document is PersonalEditTarget {
  if (document.source !== "personal") return false;
  if (!Number.isSafeInteger(document.revision)) return false;
  return (document.revision ?? 0) >= 1;
}
