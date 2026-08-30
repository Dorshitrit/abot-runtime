import type {
  LongTermMemoryRecord,
  LongTermMemoryStatus,
} from "../contracts.js";

export type LongTermMemoryManagementErrorCode =
  | "long_term_memory_disabled"
  | "long_term_memory_management_conflict"
  | "long_term_memory_management_duplicate"
  | "long_term_memory_management_input_invalid"
  | "long_term_memory_management_not_found"
  | "long_term_memory_management_sensitive_data"
  | "long_term_memory_unavailable";

export type MemoryManagementSource = "web_ui" | "management_api";

export type LongTermMemoryManagementContext = Readonly<{
  abortSignal: AbortSignal;
  debugRequestId?: string;
}>;

export type MemoryListInput = Readonly<{
  limit?: number;
  offset?: number;
}>;

export type MemoryListResult = Readonly<{
  items: readonly LongTermMemoryRecord[];
  total: number;
}>;

export type MemorySearchInput = MemoryListInput &
  Readonly<{
    query: string;
    context: LongTermMemoryManagementContext;
  }>;

export type MemorySearchResult = MemoryListResult;

export type MemoryCreateInput = Readonly<{
  content: string;
  tags: readonly string[];
  source: MemoryManagementSource;
  context: LongTermMemoryManagementContext;
}>;

export type MemoryCreateResult = Readonly<{
  record: LongTermMemoryRecord;
}>;

export type MemoryUpdateInput = Readonly<{
  id: string;
  expectedUpdatedAt: string;
  content: string;
  tags: readonly string[];
  context: LongTermMemoryManagementContext;
}>;

export type MemoryUpdateResult = Readonly<{
  record: LongTermMemoryRecord;
  updated: boolean;
}>;

export type MemoryDeleteInput = Readonly<{
  id: string;
}>;

export type MemoryDeleteResult = Readonly<{
  deleted: boolean;
}>;

export type LongTermMemoryManagementService = Readonly<{
  status(): Promise<LongTermMemoryStatus>;
  list(input?: MemoryListInput): Promise<MemoryListResult>;
  search(input: MemorySearchInput): Promise<MemorySearchResult>;
  create(input: MemoryCreateInput): Promise<MemoryCreateResult>;
  update(input: MemoryUpdateInput): Promise<MemoryUpdateResult>;
  delete(input: MemoryDeleteInput): Promise<MemoryDeleteResult>;
}>;
