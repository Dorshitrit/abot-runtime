import type { AgentDecisionConfiguration } from "./decision-records.js";

export type AgentInvocationStage = "assessment" | "selection" | "assessment_and_selection" | "authoring" | "repair" | "progress_report";

/** No price is inferred: a monetary receipt must identify its measurement/pricing source. */
export type AgentInvocationCost =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "actual" | "estimated"; amount: number; currency: string; source: string }>;

export type AgentInvocationUsage = Readonly<{
  totalTokens: number;
  cost: AgentInvocationCost;
}>;

/** Reservation is accounting, not a provider hard cap or permission to invoke. */
export type AgentInvocationRecord = Readonly<{
  id: string;
  agentId: string;
  missionId: string;
  agentRevision: number;
  missionRevision: number;
  configuration: AgentDecisionConfiguration;
  stage: AgentInvocationStage;
  publicUpdate?: string;
  reservedTokens: number;
  status: "reserved" | "usage_unknown" | "settled";
  usage: AgentInvocationUsage | null;
  createdAt: string;
  updatedAt: string;
}>;
