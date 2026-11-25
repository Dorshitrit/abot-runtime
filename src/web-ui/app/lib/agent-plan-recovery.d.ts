import type { AgentMission } from "../../../runtime/agents/agent-records.js";
import type { AgentWorkAttempt } from "../../../runtime/agents/workspace-records.js";
export declare function agentPlanRecoveryNotice(mission: AgentMission | null, attempts?: readonly AgentWorkAttempt[]): string | null;
