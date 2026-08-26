export declare function parseJsonResponseText(
  text: string,
  context: string,
): Record<string, unknown>;

export type RuntimeAvailability =
  | { status: "ready" }
  | {
      status: "setup_required";
      code: "runtime_configuration_required";
      message: string;
    };

export type RuntimeModelCatalogResponse = Record<string, unknown> & {
  defaultProfileId: string;
  profiles: Record<string, unknown>[];
  availability: RuntimeAvailability;
};

export declare function createRuntimeWebClient(options: {
  getConfig: () => Record<string, unknown> | null;
  getEnvironmentId: () => string;
  fetchImpl?: typeof fetch;
  origin?: string;
}): {
  getRuntimeStatus(): Promise<Record<string, unknown>>;
  getRuntimeLogs(lines?: number): Promise<Record<string, unknown>>;
  getSystemHealth(): Promise<Record<string, unknown>>;
  listModels(environmentId?: string): Promise<RuntimeModelCatalogResponse>;
  getAgentMode(environmentId?: string): Promise<Record<string, unknown>>;
  setAgentMode(
    mode: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  attachmentPreviewUrl(options: {
    environmentId: string;
    sessionId: string;
    storageRef: string;
    id: string;
    mimeType: string;
  }): string;
  deleteAttachment(options: {
    environmentId: string;
    sessionId: string;
    storageRef: string;
    id: string;
    mimeType: string;
  }): Promise<void>;
  uploadAttachment(options: {
    environmentId: string;
    sessionId: string;
    name: string;
    mimeType: string;
    file: Blob;
  }): Promise<Record<string, unknown>>;
  loadWebConfig(): Promise<Record<string, unknown>>;
  listSessions(environmentId?: string): Promise<Record<string, unknown>>;
  loadSession(
    sessionId: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  markSessionRead(options: {
    sessionId: string;
    environmentId?: string;
    readThroughMessageId?: number | null;
  }): Promise<Record<string, unknown>>;
  clearSessionMessages(
    sessionId: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  deleteSession(
    sessionId: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  fetchRequestEvents(options: {
    requestId: string;
    afterSeq?: number;
    environmentId?: string;
  }): Promise<unknown[]>;
  postChatMessage(options: {
    text: string;
    attachments: unknown[];
    environmentId?: string;
    sessionId: string;
    agentMode: string;
    toolPermissionMode: string;
    modelPreference?: Record<string, unknown> | null;
  }): Promise<string>;
  loadConfigDashboard(environmentId?: string): Promise<Record<string, unknown>>;
  saveConfigFile(options: {
    environmentId?: string;
    kind: string;
    id: string;
    config: unknown;
  }): Promise<Record<string, unknown>>;
};
