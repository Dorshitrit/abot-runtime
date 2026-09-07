export type LocalRuntimeCallHandler = (
  method: string,
  args: readonly unknown[],
) => Promise<unknown>;

export type LocalRuntimePeer = Readonly<{
  id: string;
  callClient: LocalRuntimeCallHandler;
  onClose: (listener: () => void) => () => void;
}>;

export type LocalRuntimeOwner = Readonly<{
  call: (
    method: string,
    args: readonly unknown[],
    peer: LocalRuntimePeer,
  ) => Promise<unknown>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  stop: () => Promise<void>;
  /** Synchronous activity snapshot; stable after stop has closed intake. */
  isIdle?: () => boolean;
  /** Settles only after stopped-owner execution and persistence have finished. */
  whenIdle?: () => Promise<void>;
}>;

export type LocalRuntimeConnection = Readonly<{
  ownership: "owner" | "client";
  call: (method: string, args?: readonly unknown[]) => Promise<unknown>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  setClientHandler: (handler: LocalRuntimeCallHandler) => void;
  onClose: (listener: () => void) => () => void;
  close: () => Promise<void>;
}>;

export type LocalRuntimeConnectionOptions = Readonly<{
  directory: string;
  identity: string;
  createOwner: () => Promise<LocalRuntimeOwner>;
  startupTimeoutMs?: number;
}>;

export type LocalRuntimeEndpoint = Readonly<{
  version: 1;
  identity: string;
  pid: number;
  port: number;
  token: string;
}>;
