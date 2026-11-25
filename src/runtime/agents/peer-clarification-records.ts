export type AgentPeerClarificationRequest=Readonly<{
  parentAgentId:string;childAgentId:string;childMissionId:string;exchangeId:string;questionMessageId:string;signal:AbortSignal;
}>;
export type AgentPeerClarificationRecord=Readonly<{
  id:string;childAgentId:string;childMissionId:string;questionMessageId:string;question:string;invocationId:string;reservedTokens:number;
  status:"reserved"|"answered"|"awaiting_user_decision"|"unknown";answer:string|null;usageTokens:number|null;createdAt:string;updatedAt:string;
}>;
