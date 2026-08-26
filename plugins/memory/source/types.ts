export type MemoryEntry = Readonly<{
  id: string;
  content: string;
  createdAt: string;
}>;

export type MemoryStoreState = Readonly<{
  entries: readonly MemoryEntry[];
  nextSequence: number;
}>;

export type MemoryStoreErrorCode =
  | "invalid_memory_store"
  | "memory_store_capacity_exceeded"
  | "memory_store_busy"
  | "memory_store_too_large"
  | "memory_store_unavailable";

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode;

  constructor(code: MemoryStoreErrorCode, message: string) {
    super(message);
    this.name = "MemoryStoreError";
    this.code = code;
  }
}

export function isMemoryStoreError(error: unknown): error is MemoryStoreError {
  return error instanceof MemoryStoreError;
}
