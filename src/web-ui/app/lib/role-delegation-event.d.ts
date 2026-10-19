export interface RoleDelegation {
  id: string;
  generation: string;
  callerCallId: string;
  callerRole: "supervisor";
  childCallId: string;
  childRole: "planner" | "worker" | "researcher" | "reviewer";
  objective: string;
}

export declare function isRoleDelegationEvent(event: unknown): boolean;
export declare function projectRoleDelegationEvent(
  event: Record<string, unknown>,
): RoleDelegation | null;
export declare function hasRecordedRoleDelegation(
  events: Record<string, unknown>[],
  delegation: RoleDelegation,
): boolean;
