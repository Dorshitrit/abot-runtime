export type MemoryActivity = {
  state: "active" | "done" | "failed" | "incomplete";
  label: string;
  detail: string;
};

export declare function isMemoryRetrievalEvent(event: unknown): boolean;
export declare function buildMemoryActivities(input?: {
  requestId?: string;
  events?: Record<string, unknown>[];
  streaming?: boolean;
}): MemoryActivity[];
