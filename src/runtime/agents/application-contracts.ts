import type { AgentApprovalAttention } from "./approval-attention.js";
import type { AgentPeerClarificationRequest } from "./peer-clarification-records.js";
import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { AgentMissionLimits, AgentRecord, AgentState } from "./agent-records.js";
import type { FileAgentStateStore } from "./file-store.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import type { AgentConversationMessage, AgentWorkAttempt, AgentPeerUsage } from "./workspace-records.js";

/** External client of the existing runtime. Implementations must not change the looper. */
export type AgentWorkRequest = Readonly<{
  agentId: string; missionId: string; attemptId: string; requestId: string; sessionId: string;
  assignment: string; modelProfileId: string; toolPermissionMode: ToolPermissionMode;
}>;
export type AgentWorkResult = Readonly<{
  status: "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "unknown";
  output: string | null;
  error: string | null;
  /** Only usage already supplied by the ordinary session, never inferred from prose. */
  usage: Readonly<{ modelCalls: number; totalTokens: number }> | null;
  /** Stable existing request generation/terminal identity, if provided by the runtime. */
  receiptId: string | null;
}>;
export type AgentWorkPort = Readonly<{
  createSession(request: AgentWorkRequest): Promise<void>;
  run(request: AgentWorkRequest, signal: AbortSignal): Promise<AgentWorkResult>;
  inspect(request: AgentWorkRequest): Promise<AgentWorkResult>;
  /** Confirmed live lower bound only; not a final accounting receipt. */
  inspectUsage?(request: AgentWorkRequest): Promise<Readonly<{modelCalls:number;totalTokens:number}> | null>;
  /** Ordinary steering only; deferred means no instruction was accepted. */
  adviseWrapUp?(request: AgentWorkRequest): Promise<"accepted" | "deferred" | "unavailable">;
  cancel?(request: AgentWorkRequest): Promise<AgentWorkResult>;
}>;
export type AgentApplicationStatus = "idle" | "thinking" | "working" | "awaiting_approval" | "awaiting_user_decision" | "failed" | "archived";
export type AgentApplicationDetail = Readonly<{
  isDeleting?: boolean;
  approvalAttention?: AgentApprovalAttention;
  replyingToMessageIds?: readonly string[];
  pendingUserQuestionId?: string | null;
  peerClarification?:Readonly<{questionMessageId:string;exchangeId:string;parentAgentId:string;childMissionId:string}>|null;
  recovery: Readonly<{requiresNewBudget:boolean; unansweredUpdateId?:string; pausedChatBlock?:string|null; recordedWorkDelivery?:"output"|"empty"; budgetStopReason?:"agents_token_limit_reached"|"agents_model_call_limit_reached"; budgetStopping?:boolean; budgetSessionId?:string}>; agent: AgentRecord; status: AgentApplicationStatus; messages: readonly AgentConversationMessage[];
  mission: AgentState["missions"][number] | null;
  sessions: AgentState["sessions"]; attempts: readonly AgentWorkAttempt[];
  decisions: AgentState["decisions"]; responsibility: AgentState["responsibility"]; mailbox: AgentState["mailbox"]; activity: string | null;
}>;
export type AgentMessageInput = Readonly<{
  messageId: string; text: string; intent: "task" | "message" | "auto";
  limits?: AgentMissionLimits;
  expectedAgentRevision?:number;
}>;
export type AgentApplicationService = Readonly<{
  snapshot(): Promise<Readonly<{ revision: number; agents: readonly AgentApplicationDetail[] }>>;
  detail(agentId: string): Promise<AgentApplicationDetail>;
  receive(agentId: string, input: AgentMessageInput, source: Readonly<{agentId:string;missionId:string;correlationId:string}>): Promise<AgentApplicationDetail>;
  send(agentId: string, input: AgentMessageInput): Promise<AgentApplicationDetail>;
  answerPeerClarification(request:AgentPeerClarificationRequest):Promise<"answered"|"awaiting_user_decision">;
  pause(agentId:string):Promise<AgentApplicationDetail>;
  steer(agentId:string,input:Readonly<{text:string;limits?:AgentMissionLimits}>):Promise<AgentApplicationDetail>;
  cancel(agentId: string, expectedMissionId?: string): Promise<AgentApplicationDetail>;
  resolve(agentId: string, input: Readonly<{ action: "continue" | "cancel"; text?: string; limits?:AgentMissionLimits }>): Promise<AgentApplicationDetail>;
  refresh(agentId: string, expectedMissionId?: string): Promise<AgentApplicationDetail>;
  recover(): Promise<void>;
  associatedSessionIds(): Promise<readonly string[]>;
  whenIdle(agentId?: string): Promise<void>;
  shutdown(): Promise<void>;
  isBusy(): boolean;
}>;
export type AgentApplicationDependencies = Readonly<{
  store: FileAgentStateStore; config: RuntimeConfig; models: ModelGatewayClient; work: AgentWorkPort;
  /** Explicit manager-call reserve; callers choose a finite allowance, no hidden production default. */
  managementTokenReservation?: number;
  peers?: (agentId: string) => Promise<readonly AgentPeerSummary[]>;
  coordinate?: (request: AgentCoordinationRequest) => Promise<Readonly<{text:string;usage:AgentPeerUsage|null;outcome:"completed"|"exhausted"|"cancelled"}>>;
}>;

export type AgentPeerSummary = Readonly<{
  id:string; name:string; modelProfileId:string; purpose:string; status:AgentApplicationStatus;
  source?: "onboarding" | "base_prompt_fallback";
  notes?: string;
  preferredOutputs?: readonly string[];
  purposeOmittedCharacters?: number;
  notesOmittedCharacters?: number;
}>;
export type AgentCoordinationRequest = Readonly<{
  correlationId:string; senderAgentId:string; missionId:string; recipientAgentId:string;
  assignment:string; limits:AgentMissionLimits; toolPermissionMode:ToolPermissionMode; signal:AbortSignal;
}>;
