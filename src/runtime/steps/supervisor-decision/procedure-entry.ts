import {
  SUPERVISOR_DELEGATE_ROLE_IDS,
  type SupervisorDecisionCallIdentity,
  type SupervisorDelegateRoleId,
  type SupervisorResumeContext,
} from "./contracts.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { projectRootMemoryRecallMessage } from "../../long-term-memory/recall-context.js";
import { canOfferMemoryRecall } from "../../long-term-memory/recall-policy.js";

type ProcedureEntryOptions = Readonly<{
  resume?: SupervisorResumeContext;
  call: SupervisorDecisionCallIdentity;
  skillReadHead?: RoleCallLedgerHead;
  memoryRecallMessage?: ChatMessage;
  toolResults: RequestToolResultsView;
  allowedRoleIds?: readonly SupervisorDelegateRoleId[];
}>;

type ProcedureEntry = Readonly<{
  classifyProcedure: boolean;
  allowInitialMemoryRecall: boolean;
  memoryRecallMessage: ChatMessage | undefined;
}>;

/** One canonical projection owns initial entry, recall eligibility and its receipt. */
export function projectSupervisorProcedureEntry(
  options: ProcedureEntryOptions,
  steeringVersion: number,
): ProcedureEntry {
  const continuation = Object.freeze({
    classifyProcedure: false, allowInitialMemoryRecall: false,
    memoryRecallMessage: options.memoryRecallMessage,
  });
  if (options.resume !== undefined) return continuation;
  if (options.toolResults.results.length > 0) return continuation;
  if (!hasProcedureDelegate(options)) return continuation;
  const head = options.skillReadHead;
  // Isolated callers retain fresh classification, but cannot open a recall
  // without canonical state proving that its initial allowance is unused.
  if (!head) return Object.freeze({
    ...continuation, classifyProcedure: options.memoryRecallMessage === undefined,
  });
  const root = head.state.calls.find(call => call.callId === head.state.rootCallId);
  if (!root) return continuation;
  if (root.callId !== options.call.callId) return continuation;
  if (root.status !== "active") return continuation;
  if (root.activationCount !== options.call.invocationAttempt) return continuation;
  if (root.childCallIds.length > 0) return continuation;
  return Object.freeze({
    classifyProcedure: true,
    allowInitialMemoryRecall: !hasInitialRecallForCurrentIntent(head, steeringVersion),
    memoryRecallMessage: projectRootMemoryRecallMessage({
      head, callId: root.callId, steeringVersion,
    }),
  });
}

function hasProcedureDelegate(options: ProcedureEntryOptions): boolean {
  const roles = options.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS;
  return roles.some((role) => role === "worker" || role === "planner");
}

export function canRecallSupervisorMemory(
  entry: ProcedureEntry,
  policy: Parameters<typeof canOfferMemoryRecall>[0],
): boolean {
  if (!policy.enabled) return false;
  if (entry.classifyProcedure && !entry.allowInitialMemoryRecall) return false;
  return canOfferMemoryRecall(policy);
}

function hasInitialRecallForCurrentIntent(head: RoleCallLedgerHead, steeringVersion: number): boolean {
  return head.state.memoryRecalls.some(recall => {
    if (recall.callId !== head.state.rootCallId) return false;
    if (recall.steeringVersion !== steeringVersion) return false;
    return recall.completedChildCount === 0;
  });
}
