import type { RuntimeLogsResetResult } from "../../../../runtime/local-host/maintenance-contracts.js";
import type { RuntimeSessionResetNotice } from "../../../local-runtime/workspace-notifications.js";

export interface RuntimeMaintenanceClient {
  supportsRuntimeMaintenance(): boolean;
  resetRuntimeSessions(environmentId: string): Promise<{ ok: true; result: RuntimeSessionResetNotice }>;
  clearRuntimeLogs(environmentId: string): Promise<{ ok: true; result: RuntimeLogsResetResult }>;
}

export declare function createRuntimeMaintenanceRequests(dependencies: {
  requestApi: (path: string, options: { method: string; body: string }) => Promise<unknown>;
  environmentQuery: (environmentId: string) => string;
  getConfig: () => { backend?: string } | undefined;
}): RuntimeMaintenanceClient;
