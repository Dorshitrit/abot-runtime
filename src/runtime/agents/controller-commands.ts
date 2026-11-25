import type { AgentDecisionConfiguration } from "./decision-records.js";
import type { AgentInvocationStage, AgentInvocationUsage } from "./invocation-records.js";

/** Trusted controller envelope. Model output is confined to proposalJson. */
export type AgentControllerCommand =
  | Readonly<{
      kind: "reserve_invocation";
      agentId: string;
      missionId: string;
      invocationId: string;
      agentRevision: number;
      missionRevision: number;
      configuration: AgentDecisionConfiguration;
      stage: AgentInvocationStage;
      reservedTokens: number;
    }>
  | Readonly<{
      kind: "settle_invocation";
      agentId: string;
      invocationId: string;
      usage: AgentInvocationUsage | null;
      progressReport?: Readonly<{ workId: string; text: string }>;
    }>
  | Readonly<{
      kind: "record_decision";
      agentId: string;
      invocationId: string;
      decisionId: string;
      proposalJson: string;
      currentConfiguration: AgentDecisionConfiguration | null;
    }>;
