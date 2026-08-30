import type {
  LongTermMemoryRecord,
  LongTermMemorySnapshot,
} from "../../controllers/long-term-memory/controller.js";

export type LongTermMemoryManagerView = LongTermMemorySnapshot &
  Readonly<{
    editorRecord: LongTermMemoryRecord | null;
    canWrite: boolean;
    busy: boolean;
    status: Readonly<{
      tone: "enabled" | "disabled" | "unavailable";
      label: "Enabled" | "Disabled" | "Unavailable";
    }>;
    emptyMessage: string;
    pageLabel: string;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  }>;

export declare function createMemoryManagerView(
  snapshot: LongTermMemorySnapshot,
): LongTermMemoryManagerView;
export declare function parseMemoryTags(value: unknown): string[];
export declare function formatMemoryTimestamp(value: unknown): string;
export declare function memoryOriginLabel(origin: unknown): string;
export declare function buildMemoryDeleteConfirmation(
  record: Pick<LongTermMemoryRecord, "content">,
): string;
