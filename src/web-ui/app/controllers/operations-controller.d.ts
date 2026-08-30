export declare function formatDurationMs(value: unknown): string;
export declare function latestHealthEvent(
  details: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined;

export interface OperationsControllerDependencies {
  readonly dom: Readonly<{
    runtimeStatus: Pick<HTMLElement, "innerHTML" | "textContent">;
    runtimeLogs: Pick<HTMLElement, "textContent">;
    healthStatus: Pick<HTMLElement, "innerHTML" | "textContent">;
  }>;
  readonly client: Readonly<{
    getRuntimeStatus(): Promise<Record<string, unknown>>;
    getRuntimeLogs(lines: number): Promise<Record<string, unknown>>;
    getSystemHealth(): Promise<Record<string, unknown>>;
  }>;
}

export declare function createOperationsController(
  options: OperationsControllerDependencies,
): {
  loadRuntimeStatus(): Promise<void>;
  loadRuntimeLogs(): Promise<void>;
  loadSystemHealth(): Promise<void>;
};
