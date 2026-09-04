import type { EventRecord } from "./event-presentation.js";

export interface TaskProgressItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  order: number;
}

interface PlanEventPosition {
  source: "eventSequence" | "seqNo";
  value: number;
}

interface PlanItemUpdate {
  item: TaskProgressItem;
  position?: PlanEventPosition;
  planSummary?: string;
  planTotal?: number;
  planCompleted?: number;
}

interface PlanReplayState {
  snapshot?: {
    summary: string;
    total: number;
    completed: number;
    items: TaskProgressItem[];
    hasSnapshot: boolean;
  };
  snapshotPosition?: PlanEventPosition;
  itemUpdates: PlanItemUpdate[];
}

export interface TaskProgress {
  requestId: string;
  summary: string;
  total: number;
  completed: number;
  items: TaskProgressItem[];
  activeItem: string;
  hasSignal: boolean;
  hasSnapshot: boolean;
  lastEventSequence?: number;
  lastSeqNo?: number;
  replayState?: PlanReplayState;
}

export declare function taskStatusClass(status: unknown): string;
export declare function reduceTaskProgress(
  current: TaskProgress | undefined,
  message: EventRecord,
): TaskProgress | undefined;
