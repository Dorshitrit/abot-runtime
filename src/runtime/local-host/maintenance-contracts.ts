import type { RuntimeLogsResetResult } from "../observability/log-reset.js";
export type { RuntimeLogsResetResult } from "../observability/log-reset.js";

export type RuntimeSessionsResetResult = Readonly<{
  complete: boolean;
  deletedSessionIds: readonly string[];
  clearedSessionIds: readonly string[];
  failedSessionIds: readonly string[];
  deletedMessages: number;
  deletedRequests: number;
}>;

export type RuntimeMaintenanceService = Readonly<{
  resetSessions(): Promise<RuntimeSessionsResetResult>;
  clearLogs(): Promise<RuntimeLogsResetResult>;
}>;
