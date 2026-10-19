import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { RoleSkillReadPayload } from "../orchestration/role-calls/skill-read.js";
import {
  findRoleActivationReservationIssue,
  resolveRoleActivationBudget,
} from "../orchestration/role-calls/activation-budget.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import { KnowledgeSkillError } from "../knowledge-skills/personal-contracts.js";
import { resolveKnowledgeSkillReadTargets } from "../capabilities/knowledge-skills/read-targets.js";
import type { KnowledgeSkillStore } from "../knowledge-skills/store.js";
import type { SkillReadDecision } from "../steps/skill-read-decision.js";
import { emitRuntimeStatus } from "../events/runtime-status.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";

type ReadPayload = RoleSkillReadPayload;

/** Read synchronously, then commit the exact snapshot and the next root activation together. */
export async function performRootSkillRead(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringVersion: number;
  decision: SkillReadDecision;
}): Promise<void> {
  const { request, head, call } = params;
  request.abortSignal.throwIfAborted();
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  if (!steering.isCurrent(params.steeringVersion)) return;
  if (!hasSuperContextContract(head.policy.authority, "supervisor"))
    throw new Error("skill_read_policy_invalid");
  if (!request.knowledgeSkillStore) throw new Error("skill_read_unavailable");
  const identity = {
    authority: "runtime" as const,
    type: "record_skill_read" as const,
    callId: call.callId,
    invocationAttempt: call.activationCount,
    steeringVersion: params.steeringVersion,
  };
  const reservation = {
    ...identity,
    ...failedRead(params.decision, "knowledge_skill_unavailable"),
  };
  const exhausted = findRoleActivationReservationIssue(
    head.state,
    head.policy,
    reservation,
  );
  if (exhausted) throw new Error(`role_call_ledger_rejected:${exhausted.code}`);
  const payload = readStore(request.knowledgeSkillStore, params.decision);
  request.abortSignal.throwIfAborted();
  if (!steering.isCurrent(params.steeringVersion)) return;
  const committed = await params.ledger.apply({
    expectedHead: head,
    command: { ...identity, ...payload },
  });
  if (!committed.ok)
    throw new Error(`role_call_ledger_rejected:${committed.code}`);
  emitRuntimeStatus(request, {
    stage: "supervisor",
    phase: "skills",
    message: readStatus(payload),
  });
}

function readStore(
  store: KnowledgeSkillStore,
  decision: SkillReadDecision,
): ReadPayload {
  try {
    if (decision.action === "list_skills")
      return {
        operation: "list_skills",
        selectors: [],
        result: {
          outcome: "completed",
          skills: store.list().map((skill) => ({ ...skill })),
        },
      };
    const resolved = resolveKnowledgeSkillReadTargets(store, decision.skillIds);
    if (!resolved.ok) return failedRead(decision, resolved.errorCode);
    return {
      operation: "read_skills",
      selectors: [...decision.skillIds],
      result: {
        outcome: "completed",
        skills: resolved.skills.map((skill) => ({ ...skill })),
      },
    };
  } catch (error) {
    if (error instanceof KnowledgeSkillError)
      return failedRead(decision, error.code);
    throw error;
  }
}

function failedRead(
  decision: SkillReadDecision,
  errorCode: string,
): ReadPayload {
  const result = { outcome: "failed" as const, errorCode, skills: [] as const };
  if (decision.action === "list_skills")
    return { operation: "list_skills", selectors: [], result };
  return {
    operation: "read_skills",
    selectors: [...decision.skillIds],
    result,
  };
}

function readStatus(payload: ReadPayload): string {
  if (payload.result.outcome === "failed")
    return `Skill lookup failed: ${payload.result.errorCode}`;
  if (payload.operation === "list_skills")
    return `Listed ${payload.result.skills.length} Skills`;
  return `Read Skills: ${payload.result.skills.map(({ name }) => name).join(", ")}`;
}

export function canRootReadSkills(
  request: RequestExecutionScope,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): boolean {
  if (!request.knowledgeSkillStore) return false;
  if (!hasSuperContextContract(head.policy.authority, "supervisor"))
    return false;
  return (
    call.activationCount <
    resolveRoleActivationBudget(head.state, head.policy)
      .maximumAcceptedActivationsPerCall
  );
}
