import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";

/** Runtime-derived configuration identity, never authority supplied by model prose. */
export type AgentDecisionConfiguration = Readonly<{
  schemaVersion: 1;
  fingerprint: string;
  modelProfileId: string;
  baseProfileId: string;
  policy: Readonly<{ id: RequestExecutionPolicyId; source: "model_profile" | "default"; version: number; definitionHash: string }>;
  toolPermissionMode: ToolPermissionMode;
}>;

export type AgentDecisionAction =
  | Readonly<{ kind: "answer_user" }>
  | Readonly<{ kind: "read_evidence" }>
  | Readonly<{ kind: "start_session"; gap: string; approach: string; expectedEvidence: string }>
  | Readonly<{ kind: "continue_session"; sessionId: string; gap: string; approach: string; expectedEvidence: string }>
  | Readonly<{ kind: "wait"; condition: string }>
  | Readonly<{ kind: "ask_user"; question: string }>
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "exhausted" }>;

/** Selection and operational reason only; substantive work payload authoring is separate. */
export type AgentDecisionProposal = Readonly<{
  action: AgentDecisionAction;
  reason: string;
  evidenceIds: readonly string[];
}>;

/** Acceptance records a waiting transition, never question delivery or executed work. */
export type AgentDecisionTrace = Readonly<{
  id: string;
  agentId: string;
  missionId: string;
  invocationId: string;
  agentRevision: number;
  missionRevision: number;
  configuration: AgentDecisionConfiguration;
  proposal: AgentDecisionProposal | null;
  proposalFingerprint: string;
  outcome: "accepted" | "rejected";
  code: string;
  recordedAt: string;
}>;
