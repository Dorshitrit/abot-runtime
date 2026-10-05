export type ContextReplayScope = Readonly<{
  environmentId: string;
  sessionId: string;
  viewVersion: number;
  requestId: string;
  generation: string;
}>;
export declare function captureContextReplayScope(
  state: {
    currentSessionId: string;
    sessionViewVersion: number;
    requestLifecycles?: Map<string, Record<string, unknown>>;
  },
  environmentId: string,
  requestId: string,
): ContextReplayScope;
export declare function isContextReplayCurrent(
  scope: ContextReplayScope,
  state: {
    currentSessionId: string;
    sessionViewVersion: number;
    requestLifecycles?: Map<string, Record<string, unknown>>;
  },
  environmentId: string,
): boolean;
export declare function bindContextReplayEvents(
  events: unknown[],
  scope: ContextReplayScope,
): Record<string, unknown>[];
export declare function contextReplayBinding(
  event: Record<string, unknown>,
): (ContextReplayScope & { replayDomain: object; replayOrder: number }) | null;
