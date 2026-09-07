export type SessionReadStateEntry = Record<string, unknown> & {
  id?: unknown;
  lastReadAt?: unknown;
  readState?: Record<string, unknown>;
};

export declare function isOlderSessionReadState(
  incoming: SessionReadStateEntry | null | undefined,
  known: SessionReadStateEntry | null | undefined,
): boolean;

export declare function isSessionReadStateUnavailable(
  value: SessionReadStateEntry | null | undefined,
): boolean;

export declare function mergeSessionReadStateUpdate<
  T extends SessionReadStateEntry,
>(incoming: T, known: SessionReadStateEntry | null | undefined): T;

export declare function mergeSessionListReadState<
  T extends SessionReadStateEntry,
>(incomingSessions: T[], knownSessions: SessionReadStateEntry[]): T[];
