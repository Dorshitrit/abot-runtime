export interface ManagedLlamaClient {
  getManagedLlamaStatus(environmentId?: string): Promise<unknown>;
  managedLlamaAction(action: string, input?: Record<string, unknown>, environmentId?: string): Promise<unknown>;
}
export interface ManagedLlamaServerClient {
  getManagedLlamaServer(environmentId?: string): Promise<unknown>;
  managedLlamaServerAction(action: string, input?: Record<string, unknown>, environmentId?: string): Promise<unknown>;
}
export declare function createManagedLlamaRequests(dependencies: {
  requestApi: (path: string, options?: { method: string; body: string }) => Promise<unknown>;
  environmentQuery: (environmentId?: string) => string;
}): ManagedLlamaClient & ManagedLlamaServerClient;
