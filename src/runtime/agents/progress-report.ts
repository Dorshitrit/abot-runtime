import { directAgentRequestOrigin } from "./delegated-work-origin.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentMission, AgentState } from "./agent-records.js";

export type AgentProgressCheckpoint = Readonly<{
  agentId: string; missionId: string; workId: string; workKind: "work_session" | "delegation";
  dueAt: string; lastUpdateId?: string; lastUpdateText?: string;
  workUsage?: Readonly<{ modelCalls: number; totalTokens: number }> | null;
}>;
export type ProgressObservation = Readonly<{
  source: AgentProgressCheckpoint;
  current(): Promise<AgentProgressCheckpoint | null>;
}>;

export function sameProgressCheckpoint(a: AgentProgressCheckpoint, b: AgentProgressCheckpoint | null): boolean {
  return !!b && a.agentId === b.agentId && a.missionId === b.missionId &&
    a.workId === b.workId && a.workKind === b.workKind && a.lastUpdateId === b.lastUpdateId && a.dueAt === b.dueAt;
}

export function progressContext(state: AgentState, mission: AgentMission, checkpoint: AgentProgressCheckpoint): ChatMessage[] {
  const origin = directAgentRequestOrigin(state, mission.agentId, mission.id);
  if (!origin) throw new Error("agents_progress_missing_bound_request");
  return [
    { role: "system", content: "Write one short public progress update in the user's language, at most 360 characters. Use only the observed status below. If there are no new findings, say that work is still underway. Do not perform work, invent results, ask questions, disclose private reasoning, or promise an ETA. Output only the message." },
    { role: "system", content: JSON.stringify({kind: "agent_work_status_v1", authority: "presentation_only", work: checkpoint.workKind,
      active: true, confirmedQuietMinutes: 5, previousPublicUpdate: checkpoint.lastUpdateText?.slice(0,500) ?? null}) },
    { role: "user", content: origin.text },
  ];
}
