export type SocketConnectionPreview = Readonly<{
  localEnvironmentId: string;
  remoteRuntimeId: string;
  serverOrigin: string;
  bindingConfirmationRequired: boolean;
}>;

export type SocketConnectionStatus = Readonly<{
  revision: number;
  localEnvironmentId: string;
  remoteRuntimeId: string | null;
  serverOrigin: string | null;
  source: "managed" | "legacy" | null;
  state: "not_configured" | "connecting" | "connected" | "reconnecting" | "paused" | "offline";
  lastRegisteredAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
}>;

export type SocketConnectionChange = Readonly<{ expectedRevision: number }>;
export type SocketConnectionImport = SocketConnectionChange & Readonly<{ bundle: unknown; confirmBinding?: boolean }>;
export interface SocketConnectionManagement {
  status(): Promise<SocketConnectionStatus>;
  preview(bundle: unknown): Promise<SocketConnectionPreview>;
  import(input: SocketConnectionImport): Promise<SocketConnectionStatus>;
  pause(input: SocketConnectionChange): Promise<SocketConnectionStatus>;
  resume(input: SocketConnectionChange): Promise<SocketConnectionStatus>;
  forget(input: SocketConnectionChange): Promise<SocketConnectionStatus>;
}

export function socketConnectionClient(call: (method: string, args: readonly unknown[]) => Promise<unknown>): SocketConnectionManagement {
  const op = (method: string, args: readonly unknown[]) => call(`socketConnection.${method}`, args) as Promise<SocketConnectionStatus>;
  return {
    status: () => op("status", []),
    preview: bundle => call("socketConnection.preview", [bundle]) as Promise<SocketConnectionPreview>,
    import: input => op("import", [input]),
    pause: input => op("pause", [input]),
    resume: input => op("resume", [input]),
    forget: input => op("forget", [input]),
  };
}
