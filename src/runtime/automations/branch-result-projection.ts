import type { BranchResult, SettledNodeResult } from "./binding-resolution.js";
import type { CompiledParallelGroup } from "./graph-validation.js";

/** A join projects only its terminal producers; earlier outputs need explicit bindings. */
export function projectAutomationBranchResults(
  groups: readonly CompiledParallelGroup[],
  settled: ReadonlyMap<string, SettledNodeResult>,
): ReadonlyMap<string, readonly BranchResult[]> {
  const projected = new Map<string, readonly BranchResult[]>();
  for (const group of groups) {
    const hasSettledBranchTails = group.tailNodeIds.every((id) => settled.has(id));
    if (!hasSettledBranchTails) continue;
    projected.set(group.id, group.tailNodeIds.map((nodeId) => {
      const result = settled.get(nodeId)!;
      return { nodeId, status: result.status,
        ...(result.resultRef ? { resultRef: result.resultRef } : {}) };
    }));
  }
  return projected;
}
