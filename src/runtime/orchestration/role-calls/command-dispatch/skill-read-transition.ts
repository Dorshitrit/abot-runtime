import type {
  RoleCallPolicy, RoleCallState, RoleCallTransitionResult,
} from "../contracts.js";
import type { RecordRoleSkillReadCommand, RoleSkillRead } from "../skill-read.js";
import { commit, reject } from "../reducer-primitives.js";
import { replaceCall } from "./call-frame-state.js";

/** A synchronous core lookup returns in one commit without a child or waiting state. */
export function recordSkillRead(
  state: RoleCallState,
  command: RecordRoleSkillReadCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const call = state.calls.find((candidate) => candidate.callId === command.callId);
  if (!call) return reject(state, "skill_read_caller_invalid");
  const usesSupervisorContract = policy.authority.rootContractId === "supervisor";
  if (!usesSupervisorContract) return reject(state, "skill_read_caller_invalid");
  const ownsActiveRequest =
    state.phase === "running" &&
    state.activeCallId === command.callId &&
    state.rootCallId === command.callId;
  if (!ownsActiveRequest) return reject(state, "skill_read_caller_invalid");
  const isActiveSupervisorRoot =
    call.parentCallId === null &&
    call.roleId === "supervisor" &&
    call.status === "active";
  if (!isActiveSupervisorRoot) return reject(state, "skill_read_caller_invalid");
  const previousReads = state.skillReads ?? [];
  const matchesCurrentActivation = call.activationCount === command.invocationAttempt;
  if (!matchesCurrentActivation) return reject(state, "skill_read_invocation_mismatch");
  const preservesSteeringOrder =
    command.steeringVersion >= (previousReads.at(-1)?.steeringVersion ?? 0);
  if (!preservesSteeringOrder) return reject(state, "skill_read_invocation_mismatch");
  const { authority: _authority, type: _type, ...payload } = command;
  const read: RoleSkillRead = {
    ...payload,
    readId: `skill-read-${previousReads.length + 1}`,
  };
  return commit({
    ...state,
    calls: replaceCall(state.calls, {
      ...call,
      activationCount: call.activationCount + 1,
    }),
    skillReads: [...previousReads, read],
  }, {
    type: "skill_read_recorded",
    callId: call.callId,
    readId: read.readId,
    invocationAttempt: read.invocationAttempt,
    steeringVersion: read.steeringVersion,
    operation: read.operation,
  });
}
