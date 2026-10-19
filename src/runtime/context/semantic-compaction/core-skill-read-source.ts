import type { RoleCallFrame, RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { CompactionSourceInvariantError } from "../compaction-source-invariant.js";
import { buildCoreSkillReadContextMessage, coreSkillReadSourceRef } from "../core-skill-read-context.js";
import type { SemanticCompactionSource } from "./contracts.js";

/** Rebuild from the captured ledger snapshot, never from the current Skills Store. */
export function assertCoreSkillReadSource(params: Readonly<{
  source: SemanticCompactionSource;
  record: Record<string, unknown>;
  head: RoleCallLedgerHead;
  scopeCall?: RoleCallFrame;
}>): void {
  const { source, record, head, scopeCall } = params;
  const binding = object(record.read);
  const read = head.state.skillReads?.find((entry) => entry.readId === binding?.readId);
  const skillId = object(record.document)?.skillId;
  const document = read?.operation === "read_skills" && read.result.outcome === "completed"
    ? read.result.skills.find((skill) => skill.skillId === skillId) : undefined;
  if (
    !read || read.callId !== head.state.rootCallId ||
    (read.operation === "read_skills" && read.result.outcome === "completed" && !document) ||
    (record.document !== undefined && !document) ||
    (scopeCall && !isOwnedConsumer(head, scopeCall, document !== undefined)) ||
    source.sourceRef !== coreSkillReadSourceRef(read.readId, document?.skillId) ||
    source.content !== JSON.stringify(buildCoreSkillReadContextMessage(head.state.requestId, read, document))
  ) throw new CompactionSourceInvariantError("context_compaction_skill_read_source_changed", source.sourceRef);
}

function isOwnedConsumer(head: RoleCallLedgerHead, call: RoleCallFrame, hasDocument: boolean): boolean {
  if (call.roleId === "supervisor") return call.callId === head.state.rootCallId;
  if (!hasDocument ||
    (call.roleId !== "planner" && call.roleId !== "worker" && call.roleId !== "reviewer")) return false;
  const seen = new Set<string>();
  let current: RoleCallFrame | undefined = call;
  while (current && !seen.has(current.callId)) {
    if (current.callId === head.state.rootCallId) return true;
    seen.add(current.callId);
    current = head.state.calls.find((candidate) => candidate.callId === current!.parentCallId);
  }
  return false;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
