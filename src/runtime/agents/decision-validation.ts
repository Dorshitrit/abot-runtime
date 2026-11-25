import { isRequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentControllerCommand } from "./controller-commands.js";
import type { AgentDecisionConfiguration, AgentDecisionProposal, AgentDecisionTrace } from "./decision-records.js";
import {
  rejectAgentRecord, requireAgentFields, requireAgentInteger, requireAgentText, requireAgentTimestamp,
} from "./record-validation.js";

const HASH = /^sha256:[a-f0-9]{64}$/;
const REJECTION_CODES = new Set([
  "malformed_proposal", "invocation_not_settled", "invocation_stage_not_decisional", "agent_inactive", "mission_inactive",
  "stale_agent_revision", "stale_mission_revision", "configuration_changed", "budget_exhausted", "usage_pending",
  "evidence_unavailable", "session_owner_mismatch", "operation_unavailable", "clarification_limit_reached",
]);
const ACTION_FIELDS = {
  answer_user: ["kind"], read_evidence: ["kind"],
  start_session: ["kind", "gap", "approach", "expectedEvidence"],
  continue_session: ["kind", "sessionId", "gap", "approach", "expectedEvidence"],
  wait: ["kind", "condition"], ask_user: ["kind", "question"],
  complete: ["kind"], exhausted: ["kind"],
} as const;

function requireBoundedText(value: unknown, path: string, maximum = 1_000): asserts value is string {
  requireAgentText(value, path);
  if (value.length > maximum) rejectAgentRecord(path);
}

function requireFingerprint(value: unknown, path: string): void {
  if (typeof value !== "string" || !HASH.test(value)) rejectAgentRecord(path);
}

export function readAgentDecisionConfiguration(value: unknown): AgentDecisionConfiguration {
  const record = requireAgentFields(value,
    ["schemaVersion", "fingerprint", "modelProfileId", "baseProfileId", "policy", "toolPermissionMode"], "decisionConfiguration");
  if (record.schemaVersion !== 1) rejectAgentRecord("decisionConfiguration.schemaVersion");
  requireFingerprint(record.fingerprint, "decisionConfiguration.fingerprint");
  requireBoundedText(record.modelProfileId, "decisionConfiguration.modelProfileId", 256);
  requireBoundedText(record.baseProfileId, "decisionConfiguration.baseProfileId", 256);
  if (!["ask", "full_access", "full_plus"].includes(record.toolPermissionMode as string))
    rejectAgentRecord("decisionConfiguration.toolPermissionMode");
  const policy = requireAgentFields(record.policy, ["id", "source", "version", "definitionHash"], "decisionConfiguration.policy");
  if (!isRequestExecutionPolicyId(policy.id)) rejectAgentRecord("decisionConfiguration.policy.id");
  if (policy.source !== "model_profile" && policy.source !== "default") rejectAgentRecord("decisionConfiguration.policy.source");
  requireAgentInteger(policy.version, 1, "decisionConfiguration.policy.version");
  requireFingerprint(policy.definitionHash, "decisionConfiguration.policy.definitionHash");
  return structuredClone(record) as AgentDecisionConfiguration;
}

export function sameAgentDecisionConfiguration(left: AgentDecisionConfiguration, right: AgentDecisionConfiguration): boolean {
  if (left.schemaVersion !== right.schemaVersion || left.fingerprint !== right.fingerprint) return false;
  if (left.modelProfileId !== right.modelProfileId || left.baseProfileId !== right.baseProfileId) return false;
  if (left.toolPermissionMode !== right.toolPermissionMode) return false;
  if (left.policy.id !== right.policy.id || left.policy.version !== right.policy.version || left.policy.source !== right.policy.source) return false;
  return left.policy.definitionHash === right.policy.definitionHash;
}

export function readAgentDecisionProposal(value: unknown): AgentDecisionProposal {
  const record = requireAgentFields(value, ["action", "reason", "evidenceIds"], "decisionProposal");
  requireBoundedText(record.reason, "decisionProposal.reason");
  if (!Array.isArray(record.evidenceIds) || record.evidenceIds.length > 32)
    rejectAgentRecord("decisionProposal.evidenceIds");
  for (const id of record.evidenceIds) requireBoundedText(id, "decisionProposal.evidenceId", 256);
  if (new Set(record.evidenceIds).size !== record.evidenceIds.length)
    rejectAgentRecord("decisionProposal.evidenceIds.duplicate");
  const candidate = record.action;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    rejectAgentRecord("decisionProposal.action");
  const kind = (candidate as Record<string, unknown>).kind;
  if (typeof kind !== "string" || !Object.hasOwn(ACTION_FIELDS, kind)) rejectAgentRecord("decisionProposal.action.kind");
  const action = requireAgentFields(candidate, ACTION_FIELDS[kind as keyof typeof ACTION_FIELDS], "decisionProposal.action");
  for (const field of Object.keys(action).filter((key) => key !== "kind"))
    requireBoundedText(action[field], `decisionProposal.action.${field}`, field === "sessionId" ? 256 : 1_000);
  return structuredClone(record) as AgentDecisionProposal;
}

export function readAgentDecisionCommand(value: unknown): Extract<AgentControllerCommand, { kind: "record_decision" }> {
  const record = requireAgentFields(value,
    ["kind", "agentId", "invocationId", "decisionId", "proposalJson", "currentConfiguration"], "decisionCommand");
  if (record.kind !== "record_decision") rejectAgentRecord("decisionCommand.kind");
  for (const field of ["agentId", "invocationId", "decisionId"])
    requireBoundedText(record[field], `decisionCommand.${field}`, 256);
  // Invalid JSON is a model outcome to record; envelope size and authority stay strict.
  if (typeof record.proposalJson !== "string" || record.proposalJson.length > 65_536)
    rejectAgentRecord("decisionCommand.proposalJson");
  if (record.currentConfiguration !== null) readAgentDecisionConfiguration(record.currentConfiguration);
  return structuredClone(record) as Extract<AgentControllerCommand, { kind: "record_decision" }>;
}

export function validateAgentDecisionRecord(value: unknown): asserts value is AgentDecisionTrace {
  const record = requireAgentFields(value, ["id", "agentId", "missionId", "invocationId", "agentRevision",
    "missionRevision", "configuration", "proposal", "proposalFingerprint", "outcome", "code", "recordedAt"], "decision");
  for (const field of ["id", "agentId", "missionId", "invocationId"])
    requireBoundedText(record[field], `decision.${field}`, 256);
  requireAgentInteger(record.agentRevision, 1, "decision.agentRevision");
  requireAgentInteger(record.missionRevision, 1, "decision.missionRevision");
  readAgentDecisionConfiguration(record.configuration);
  if (record.proposal !== null) readAgentDecisionProposal(record.proposal);
  requireFingerprint(record.proposalFingerprint, "decision.proposalFingerprint");
  if (!["accepted", "rejected"].includes(record.outcome as string)) rejectAgentRecord("decision.outcome");
  requireBoundedText(record.code, "decision.code", 128);
  requireAgentTimestamp(record.recordedAt, "decision.recordedAt");
  if (record.outcome === "accepted" && (record.proposal as AgentDecisionProposal | null)?.action.kind !== "ask_user")
    rejectAgentRecord("decision.accepted_action");
  if (record.outcome === "accepted" && record.code !== "awaiting_user_decision") rejectAgentRecord("decision.accepted_code");
  if (record.outcome === "rejected" && !REJECTION_CODES.has(record.code as string)) rejectAgentRecord("decision.rejected_code");
  if ((record.proposal === null) !== (record.code === "malformed_proposal")) rejectAgentRecord("decision.malformed_code");
  if (record.outcome === "accepted" && (record.proposal as AgentDecisionProposal).evidenceIds.length > 0)
    rejectAgentRecord("decision.accepted_evidence_unavailable");
}

function hasRecordedWaitingTransition(decision: AgentDecisionTrace, mission: AgentMission): boolean {
  if (mission.revision !== decision.missionRevision + 1) return true;
  if (mission.status !== "awaiting_user_decision") return false;
  return decision.proposal?.action.kind === "ask_user" && mission.waitingReason === decision.proposal.action.question;
}

export function validateAgentDecisionState(state: AgentState): void {
  const ids = new Set<string>();
  const invocations = new Set<string>();
  const acceptedByMission = new Map<string, number>();
  for (const decision of state.decisions) {
    validateAgentDecisionRecord(decision);
    if (ids.has(decision.id)) rejectAgentRecord("decisions.duplicate_id");
    if (invocations.has(decision.invocationId)) rejectAgentRecord("decisions.duplicate_invocation");
    ids.add(decision.id);
    invocations.add(decision.invocationId);
    const agent = state.agents.find((entry) => entry.id === decision.agentId);
    const mission = state.missions.find((entry) => entry.id === decision.missionId);
    const invocation = state.invocations.find((entry) => entry.id === decision.invocationId);
    if (!agent || !mission || mission.agentId !== decision.agentId) rejectAgentRecord("decision.owner_mismatch");
    if (!invocation || invocation.agentId !== decision.agentId || invocation.missionId !== decision.missionId)
      rejectAgentRecord("decision.invocation_mismatch");
    if (decision.agentRevision > agent.revision || decision.missionRevision > mission.revision)
      rejectAgentRecord("decision.future_revision");
    if (decision.agentRevision !== invocation.agentRevision || decision.missionRevision !== invocation.missionRevision)
      rejectAgentRecord("decision.source_revision_mismatch");
    if (!sameAgentDecisionConfiguration(decision.configuration, invocation.configuration))
      rejectAgentRecord("decision.configuration_mismatch");
    const decisionalStage = decision.configuration.policy.id === "supervisor-worker-v1" ? "selection" : "assessment_and_selection";
    if (decision.outcome === "accepted" && invocation.stage !== decisionalStage)
      rejectAgentRecord("decision.stage_not_decisional");
    if (decision.outcome === "accepted" && invocation.status !== "settled")
      rejectAgentRecord("decision.usage_unsettled");
    if (decision.outcome === "accepted" && mission.revision <= decision.missionRevision)
      rejectAgentRecord("decision.wait_revision_missing");
    if (decision.outcome === "accepted" && !hasRecordedWaitingTransition(decision, mission))
      rejectAgentRecord("decision.wait_transition_missing");
    if (decision.outcome === "accepted")
      acceptedByMission.set(mission.id, (acceptedByMission.get(mission.id) ?? 0) + 1);
  }
  for (const [missionId, count] of acceptedByMission) {
    const mission = state.missions.find((entry) => entry.id === missionId)!;
    if (mission.usage.clarificationRounds < count) rejectAgentRecord("decision.clarifications_undercharged");
  }
}
