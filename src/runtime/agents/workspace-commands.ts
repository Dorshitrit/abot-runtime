import type { AgentDecisionConfiguration } from "./decision-records.js";
import type { AgentMissionLimits } from "./agent-records.js";
import type { AgentWorkResult } from "./application-contracts.js";
import type { AgentActionPlan, AgentWorkAttempt, AgentMailboxRecord, AgentPeerUsage } from "./workspace-records.js";
export type AgentWorkspaceCommand =
  | Readonly<{kind:"publish_conversation_reply";agentId:string;missionId:string;messageId:string;invocationId:string|null;text:string;withdrawAttemptId?:string}>
  | Readonly<{kind:"reserve_conversation_reply";agentId:string;missionId:string;messageId:string;invocationId:string;reservedTokens:number;agentRevision:number;missionRevision:number;configuration:AgentDecisionConfiguration}>
  | Readonly<{kind:"reserve_peer_clarification";agentId:string;missionId:string;exchangeId:string;childMissionId:string;questionMessageId:string;clarificationId:string;invocationId:string;reservedTokens:number;agentRevision:number;missionRevision:number;configuration:AgentDecisionConfiguration}>
  | Readonly<{kind:"settle_peer_clarification";agentId:string;missionId:string;exchangeId:string;clarificationId:string;outcome:"answer"|"needs_user"|"unknown";text:string|null}>
  | Readonly<{kind:"open_agent_turn";agentId:string;missionId:string;messageId:string;text:string;expectedAgentRevision?:number;intent:"task"|"message"|"auto";limits:AgentMissionLimits|null;questionId?:string;source:Readonly<{agentId:string;missionId:string;correlationId:string}>|null}>
  | Readonly<{kind:"append_agent_message";agentId:string;missionId:string;messageId:string;role:"user"|"assistant"|"abot";text:string;purpose?:"conversation"|"clarification"|"reply"}>
  | Readonly<{kind:"reject_agent_plan";agentId:string;missionId:string;traceId:string;invocationId:string}>
  | Readonly<{kind:"record_agent_plan";agentId:string;missionId:string;traceId:string;invocationId:string;plan:AgentActionPlan}>
  | Readonly<{kind:"prepare_agent_work";agentId:string;attempt:AgentWorkAttempt;traceId:string}>
  | Readonly<{kind:"claim_agent_work";agentId:string;attemptId:string;claimId:string}>
  | Readonly<{kind:"observe_agent_work";agentId:string;attemptId:string;result:AgentWorkResult}>
  | Readonly<{kind:"publish_recorded_work_result";agentId:string;missionId:string;missionRevision:number;attemptId:string;reason:string}>
  | Readonly<{kind:"finish_agent_turn";agentId:string;missionId:string;status:"completed"|"exhausted";reason:string;traceId?:string;messageId?:string;text?:string}>
  | Readonly<{kind:"resume_agent_turn";agentId:string;missionId:string;text:string|null}>
  | Readonly<{kind:"prepare_agent_exchange";agentId:string;record:AgentMailboxRecord}>
  | Readonly<{kind:"reconcile_cancelled_exchange";agentId:string;exchangeId:string}>
  | Readonly<{kind:"settle_agent_exchange";agentId:string;exchangeId:string;output:string|null;usage:AgentPeerUsage|null;outcome:"completed"|"exhausted"|"cancelled"|null}>
  | Readonly<{kind:"ask_agent_user";agentId:string;missionId:string;traceId:string;messageId:string;text:string}>
  | Readonly<{kind:"mark_agent_waiting";agentId:string;missionId:string;reason:string}>;
export const AGENT_WORKSPACE_KINDS = ["reconcile_cancelled_exchange","publish_recorded_work_result","open_agent_turn","append_agent_message","record_agent_plan","prepare_agent_work",
  "claim_agent_work","observe_agent_work","finish_agent_turn","resume_agent_turn","mark_agent_waiting","prepare_agent_exchange","settle_agent_exchange","ask_agent_user","reject_agent_plan","reserve_peer_clarification","settle_peer_clarification","publish_conversation_reply","reserve_conversation_reply"] as const;
export function isAgentWorkspaceKind(value: unknown): boolean { return AGENT_WORKSPACE_KINDS.includes(value as typeof AGENT_WORKSPACE_KINDS[number]); }
