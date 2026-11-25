import type { AgentState, AgentStateChangeKind } from "./agent-records.js";

export type AgentStateTransition = Readonly<{
  state: AgentState;
  kind: AgentStateChangeKind;
  reason: string;
  missionId?: string;
  sessionId?: string;
  unchanged?: boolean;
}>;
