import type { RuntimeMaintenanceClient } from "../services/runtime-web-client/runtime-maintenance.js";
import type { RuntimeSessionsResetResult } from "../../../runtime/local-host/maintenance-contracts.js";

export declare function formatDurationMs(value: unknown): string;
export declare function latestHealthEvent(
  details: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined;

export interface OperationsSummary {
  readonly label: string;
  readonly items: readonly {
    readonly label: string;
    readonly value: string;
    readonly dirty?: boolean;
    readonly status?: boolean;
  }[];
}

export interface OperationsControllerDependencies {
  readonly getEnvironmentId?: () => string | undefined;
  readonly onSummaryChange?: () => void;
  readonly onSessionsReset?: (result: RuntimeSessionsResetResult, environmentId: string) => Promise<void>;
  readonly dom: Readonly<{
    runtimeStatus: Pick<HTMLElement, "innerHTML" | "textContent">;
    runtimeMaintenance?: HTMLElement | null;
    runtimeLogs: Pick<HTMLElement, "textContent">;
    healthStatus: Pick<HTMLElement, "innerHTML" | "textContent">;
  }>;
  readonly client: Partial<RuntimeMaintenanceClient> & Readonly<{
    getRuntimeStatus(environmentId?: string): Promise<Record<string, unknown>>;
    getRuntimeLogs(lines: number, environmentId?: string): Promise<Record<string, unknown>>;
    getSystemHealth(): Promise<Record<string, unknown>>;
  }>;
}

export declare function createOperationsController(
  options: OperationsControllerDependencies,
): {
  observeRealtimeMessage(message: Record<string, unknown>): void;
  setCompanionResetHandler(handler: (result: RuntimeSessionsResetResult, environmentId: string) => Promise<void>): void;
  summary(tab: string): OperationsSummary;
  environmentChanged(): void;
  loadRuntimeStatus(): Promise<void>;
  loadRuntimeLogs(): Promise<void>;
  loadSystemHealth(): Promise<void>;
};
