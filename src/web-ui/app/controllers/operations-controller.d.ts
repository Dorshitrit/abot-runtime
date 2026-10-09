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
  readonly dom: Readonly<{
    runtimeStatus: Pick<HTMLElement, "innerHTML" | "textContent">;
    runtimeLogs: Pick<HTMLElement, "textContent">;
    healthStatus: Pick<HTMLElement, "innerHTML" | "textContent">;
  }>;
  readonly client: Readonly<{
    getRuntimeStatus(environmentId?: string): Promise<Record<string, unknown>>;
    getRuntimeLogs(lines: number, environmentId?: string): Promise<Record<string, unknown>>;
    getSystemHealth(): Promise<Record<string, unknown>>;
  }>;
}

export declare function createOperationsController(
  options: OperationsControllerDependencies,
): {
  summary(tab: string): OperationsSummary;
  environmentChanged(): void;
  loadRuntimeStatus(): Promise<void>;
  loadRuntimeLogs(): Promise<void>;
  loadSystemHealth(): Promise<void>;
};
