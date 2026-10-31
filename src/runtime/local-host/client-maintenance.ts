import type { LocalRuntimeCallHandler } from "./contracts.js";
import type { RuntimeMaintenanceService, RuntimeSessionsResetResult, RuntimeLogsResetResult } from "./maintenance-contracts.js";

export function createLocalMaintenanceClient(call: LocalRuntimeCallHandler): RuntimeMaintenanceService {
  return {
    resetSessions: () => call("maintenance.resetSessions", []) as Promise<RuntimeSessionsResetResult>,
    clearLogs: () => call("maintenance.clearLogs", []) as Promise<RuntimeLogsResetResult>,
  };
}
