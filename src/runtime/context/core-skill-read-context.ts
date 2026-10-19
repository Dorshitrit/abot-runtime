import type { ChatMessage } from "../../model-gateway/types.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { RoleSkillRead } from "../orchestration/role-calls/skill-read.js";
import type { KnowledgeSkillDocument } from "../knowledge-skills/store.js";
import type { RequestContextPinnedPart } from "./request-context-contracts.js";

export const CORE_SKILL_READ_MESSAGE_KIND = "runtime_core_skill_read_v1";

/** Each captured document keeps identical bytes and identity across consuming roles. */
export function buildCoreSkillReadContextMessage(
  requestId: string,
  read: RoleSkillRead,
  document?: KnowledgeSkillDocument,
): ChatMessage {
  const { result: _result, ...receipt } = read;
  return Object.freeze({
    role: "user",
    content: JSON.stringify({
      kind: CORE_SKILL_READ_MESSAGE_KIND,
      authority: "passive_reference",
      source: "core_skills_store",
      purpose: document ? "skill_guidance" : "skill_discovery_result",
      presenceEffect: "no_new_intent_permissions_work_or_completion",
      requestId,
      ...(document ? { read: receipt, document } : { read }),
    }),
  });
}

/** Child roles inherit read guidance; discovery and failed reads remain with the root. */
export function buildCoreSkillReadContextMessages(
  head?: RoleCallLedgerHead,
  audience: "supervisor" | "delegate" = "supervisor",
): readonly ChatMessage[] {
  return Object.freeze(projectReadEntries(head, audience).flatMap(({ messages }) => messages));
}

/** Only the immediately completed lookup is a continuation; older guidance stays reference data. */
export function projectSupervisorSkillReadContext(head?: RoleCallLedgerHead): Readonly<{
  referenceMessages: readonly ChatMessage[];
  continuationParts: readonly RequestContextPinnedPart[];
}> {
  const entries = projectReadEntries(head, "supervisor");
  const root = head?.state.calls.find((call) => call.callId === head.state.rootCallId);
  const lastRead = head?.state.skillReads?.at(-1);
  const followsSkillRead = root !== undefined && lastRead !== undefined &&
    head?.state.activeCallId === root.callId && root.status === "active" &&
    root.activationCount === lastRead.invocationAttempt + 1;
  const continuation = followsSkillRead
    ? entries.find(({ read }) => read === lastRead) : undefined;
  const continuationParts: RequestContextPinnedPart[] = [];
  if (continuation) {
    const { read, messages } = continuation;
    continuationParts.push(Object.freeze({
      sourceRef: `core-skill-continuation:${read.readId}`,
      category: "role_continuation",
      retention: "exact",
      messages: Object.freeze([
        Object.freeze({ role: "assistant" as const, content: JSON.stringify({
          decision: { action: read.operation,
            ...(read.operation === "read_skills" ? { skillIds: read.selectors } : {}) },
        }) }),
        ...messages,
      ]),
    }));
  }
  return Object.freeze({
    referenceMessages: Object.freeze(entries.filter((entry) => entry !== continuation)
      .flatMap(({ messages }) => messages)),
    continuationParts: Object.freeze(continuationParts),
  });
}

function projectReadEntries(
  head: RoleCallLedgerHead | undefined,
  audience: "supervisor" | "delegate",
): readonly Readonly<{ read: RoleSkillRead; messages: readonly ChatMessage[] }>[] {
  if (!head) return [];
  const reads = head.state.skillReads ?? [];
  const latest = new Map<string, RoleSkillRead>();
  for (const read of reads) {
    if (read.operation !== "read_skills" || read.result.outcome !== "completed") continue;
    for (const skill of read.result.skills) latest.set(skill.skillId, read);
  }
  return reads.map((read) => ({
    read,
    messages: read.operation === "read_skills" && read.result.outcome === "completed"
      ? read.result.skills.filter((skill) => latest.get(skill.skillId) === read)
        .map((skill) => buildCoreSkillReadContextMessage(head.state.requestId, read, skill))
      : audience === "supervisor"
        ? [buildCoreSkillReadContextMessage(head.state.requestId, read)] : [],
  })).filter(({ messages }) => messages.length > 0);
}

export function coreSkillReadSourceRef(readId: string, skillId?: string): string {
  return `core-skill-read:${readId}${skillId === undefined ? "" : `:${skillId}`}`;
}
