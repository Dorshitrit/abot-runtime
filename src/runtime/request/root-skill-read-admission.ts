import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { SkillReadDecision } from "../steps/skill-read-decision.js";
import { collectSuccessfulSkillReadIdentities } from "../steps/supervisor-decision/skill-read-state.js";

/** Enforce request-local read identity before any document lookup or ledger commit. */
export function assertRootSkillReadAdmission(
  head: RoleCallLedgerHead,
  decision: SkillReadDecision,
): void {
  if (decision.action !== "read_skills") return;
  const hasRepeatedRootSkillReadIds = new Set(decision.skillIds).size !== decision.skillIds.length;
  if (hasRepeatedRootSkillReadIds) throw new Error("skill_read_duplicate_ids");
  const completedIds = new Set(collectSuccessfulSkillReadIdentities(head.state.skillReads ?? [])
    .map(({ skillId }) => skillId));
  const repeatsCompletedRootSkillRead = decision.skillIds.some((skillId) => completedIds.has(skillId));
  if (repeatsCompletedRootSkillRead) throw new Error("skill_read_already_completed");
}
