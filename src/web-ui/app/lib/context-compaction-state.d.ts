export type ContextCompactionCycle = Readonly<{
  requestId: string;
  generation: string;
  invocationId: string;
  modelStep: string;
  profileId: string;
  status: "pending" | "completed" | "failed" | "interrupted" | "conflicted";
  started: Record<string, unknown> | null;
  terminals: ReadonlyArray<{
    event: Record<string, unknown>;
    fingerprint: string;
  }>;
  interruptedAt: Record<string, unknown> | null;
}>;
export type ContextCompactionArrow = Readonly<{
  requestId: string;
  generation: string;
  invocationId: string;
  modelStep: string;
  profileId: string;
  beforePercent: number;
  afterPercent: number;
  event: Record<string, unknown>;
}>;
export declare function reduceContextCompaction(
  cycles: Map<string, ContextCompactionCycle>,
  event: Record<string, unknown>,
  requestTerminal?: Record<string, unknown> | null,
): Map<string, ContextCompactionCycle>;
export declare function interruptContextCompactions(
  cycles: Map<string, ContextCompactionCycle>,
  terminal: Record<string, unknown>,
): Map<string, ContextCompactionCycle>;
export declare function projectContextCompactions(
  cycles: Map<string, ContextCompactionCycle>,
): {
  pendingCompaction: ContextCompactionCycle | null;
  lastCompaction: ContextCompactionArrow | null;
  lastCompactionEvent: Record<string, unknown> | null;
  openCompactionCount: number;
};
