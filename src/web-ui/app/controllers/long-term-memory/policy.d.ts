import type { LongTermMemorySnapshot } from "./controller.js";

export declare function lastPageOffset(total: number, pageSize: number): number;
export declare function previousPageOffsetAfterDelete(
  state: Pick<LongTermMemorySnapshot, "total" | "offset" | "limit">,
): number;
export declare function canUseMemoryEmbeddings(
  state: Pick<LongTermMemorySnapshot, "enabled" | "available">,
): boolean;
export declare function unavailableMemoryActionMessage(action: string): string;
export declare function isMemoryConflictError(error: unknown): boolean;
export declare function isMemoryMissingError(error: unknown): boolean;
export declare function isAbortError(error: unknown): boolean;
export declare function managementErrorMessage(error: unknown): string;
