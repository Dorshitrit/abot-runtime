export interface RoleReturn {
  id: string;
  generation: string;
  callerCallId: string;
  callerRole: "supervisor";
  childCallId: string;
  childRole: "planner";
  outcome: "completed" | "failed";
  summary: string;
}

export declare function isRoleReturnEvent(event: unknown): boolean;
export declare function projectRoleReturnEvent(
  event: Record<string, unknown>,
): RoleReturn | null;
export declare function hasRecordedRoleReturn(
  events: Record<string, unknown>[],
  receipt: RoleReturn,
): boolean;
