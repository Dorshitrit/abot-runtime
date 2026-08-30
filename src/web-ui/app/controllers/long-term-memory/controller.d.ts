import type {
  LongTermMemoryPage,
  LongTermMemoryRecord,
} from "../../services/runtime-web-client.js";

export type {
  LongTermMemoryPage,
  LongTermMemoryRecord,
} from "../../services/runtime-web-client.js";

export type LongTermMemoryEditor = Readonly<{
  mode: "create" | "edit";
  recordId: string;
  draft?: Readonly<{
    content: string;
    tags: readonly string[];
  }> | null;
}>;

export type LongTermMemorySnapshot = Readonly<{
  enabled: boolean | null;
  available: boolean | null;
  items: readonly LongTermMemoryRecord[];
  total: number;
  offset: number;
  limit: number;
  query: string;
  loading: boolean;
  mutation: string;
  message: string;
  error: string;
  editor: LongTermMemoryEditor | null;
}>;

export interface LongTermMemoryClient {
  loadLongTermMemoryStatus?(): Promise<Record<string, unknown>>;
  listLongTermMemories(options: {
    environmentId: string;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<LongTermMemoryPage>;
  searchLongTermMemories(options: {
    environmentId: string;
    query: string;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }): Promise<LongTermMemoryPage>;
  createLongTermMemory(options: {
    environmentId: string;
    content: string;
    tags: readonly string[];
  }): Promise<{ record: LongTermMemoryRecord }>;
  updateLongTermMemory(options: {
    environmentId: string;
    id: string;
    content: string;
    tags: readonly string[];
    expectedUpdatedAt: string;
  }): Promise<{ record: LongTermMemoryRecord }>;
  deleteLongTermMemory(options: {
    environmentId: string;
    id: string;
  }): Promise<Record<string, unknown>>;
}

export interface LongTermMemoryController {
  beginCreate(): void;
  beginEdit(recordId: string): void;
  cancelEdit(): void;
  changePage(direction: number): Promise<void>;
  deleteMemory(recordId: string): Promise<void>;
  dispose(): void;
  load(): Promise<void>;
  refresh(): Promise<void>;
  save(input: { content: string; tags: readonly string[] }): Promise<void>;
  search(query: string): Promise<void>;
  snapshot(): LongTermMemorySnapshot;
}

export declare function createLongTermMemoryController(options: {
  client: LongTermMemoryClient;
  getEnvironmentId: () => string;
  render: (snapshot: LongTermMemorySnapshot) => void;
  pageSize?: number;
}): LongTermMemoryController;
