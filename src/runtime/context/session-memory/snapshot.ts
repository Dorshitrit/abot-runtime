import { createRequestSessionMemory } from "./controller.js";
import type {
  CreateRequestSessionMemoryParams,
  RequestSessionMemory,
} from "./contracts.js";
import type { RequestSessionMemorySnapshot } from "./snapshot-state.js";
export type { RequestSessionMemorySnapshot } from "./snapshot-state.js";

export function captureRequestSessionMemory(
  memory: RequestSessionMemory,
): RequestSessionMemorySnapshot {
  if (!memory.snapshot) throw new Error("session_memory_snapshot_unavailable");
  return memory.snapshot();
}

export function restoreRequestSessionMemory(
  snapshot: RequestSessionMemorySnapshot,
  params: Omit<CreateRequestSessionMemoryParams, "session" | "snapshot">,
): RequestSessionMemory {
  return createRequestSessionMemory({ ...params, snapshot });
}
