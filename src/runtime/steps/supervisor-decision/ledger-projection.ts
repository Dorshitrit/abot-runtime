import { RUNTIME_ROOT_ROLE_ID } from "../../orchestration/roles.js";
import {
  projectRoleChildReturnContext,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
  type RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type {
  SupervisorDecisionCallIdentity,
  SupervisorResumeContext,
} from "./contracts.js";

export function projectSupervisorCallIdentity(
  head: RoleCallLedgerHead,
): SupervisorDecisionCallIdentity {
  const rootCallId = head.state.rootCallId;
  const activeCallId = head.state.activeCallId;
  const frame = head.state.calls.find((call) => call.callId === activeCallId);
  if (
    head.state.phase !== "running" ||
    !rootCallId ||
    activeCallId !== rootCallId ||
    frame?.roleId !== RUNTIME_ROOT_ROLE_ID ||
    frame.parentCallId !== null ||
    frame.depth !== 0 ||
    frame.status !== "active"
  ) {
    throw new Error("supervisor_call_projection_invalid");
  }
  return Object.freeze({
    rootCallId,
    callId: frame.callId,
    parentCallId: null,
    depth: frame.depth,
    invocationAttempt: frame.activationCount,
  });
}

export function projectSupervisorResumeContext(
  ledger: RoleCallLedger,
  commit: RoleCallLedgerCommitResult,
): SupervisorResumeContext {
  const resume = projectRoleChildReturnContext(ledger, commit);
  const call = projectSupervisorCallIdentity(ledger.current());
  if (
    resume.callerCallId !== call.callId ||
    resume.invocationAttempt !== call.invocationAttempt
  ) {
    throw new Error("supervisor_resume_projection_invalid");
  }
  return resume;
}
