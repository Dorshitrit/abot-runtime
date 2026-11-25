import type { AgentPeerClarificationRecord } from "./peer-clarification-records.js";
import type { AgentWorkRequest, AgentWorkResult } from "./application-contracts.js";

export type AgentConversationMessage = Readonly<{
  id: string; agentId: string; missionId: string; role: "user" | "assistant" | "abot";
  purpose?:"request"|"conversation"|"clarification"|"reply"|"question";traceId?:string;
  inputIntent?: "auto"; inReplyTo?: string;
  correctableAttemptId?: string;
  withdrawnAttemptId?: string;
  source: Readonly<{agentId:string;missionId:string;correlationId:string}> | null; text: string; createdAt: string;
}>;
export type AgentWorkAttempt = Readonly<{
  id: string; agentId: string; missionId: string; agentRevision: number; missionRevision: number;
  request: AgentWorkRequest; mode: "new" | "continue"; fingerprint: string;
  status: "prepared" | "claimed" | "running" | "awaiting_approval" | "settled" | "unknown";
  claimId: string | null; result: AgentWorkResult | null; outputHash: string | null;
  userResolved: boolean; createdAt: string; updatedAt: string;
}>;
export type AgentPlanAction = "answer_user" | "read_evidence" | "start_session" | "continue_session" | "ask_user" | "wait" | "complete" | "exhausted" | "delegate_agent";
export type AgentActionPlan = Readonly<{
  publicUpdate?: string;
  action: AgentPlanAction; reason: string; sessionId: string | null;
  recipientAgentId: string | null; evidenceIds: readonly string[]; metCriteriaIds: readonly string[];
}>;
export type AgentResponsibilityTrace = Readonly<{
  id: string; agentId: string; missionId: string; agentRevision: number; missionRevision: number;
  invocationId: string; plan: AgentActionPlan; accepted: boolean; code: string; createdAt: string;
}>;

export type AgentPeerUsage = Readonly<{ modelCalls: number; totalTokens: number; attempts: number; clarificationRounds: number }>;
export type AgentMailboxRecord = Readonly<{
  id: string; agentId: string; missionId: string; missionRevision: number; traceId: string;
  recipientAgentId: string; assignment: string; limits: import("./agent-records.js").AgentMissionLimits;
  clarifications?:readonly AgentPeerClarificationRecord[];
  status: "pending" | "answered" | "unknown"; outcome:"completed"|"exhausted"|"cancelled"|null; output: string | null; usage: AgentPeerUsage | null;
  createdAt: string; updatedAt: string;
}>;
