import { exactKeys, isRecord } from "../../validation/strict-record.js";
import type { ModelWorkPlanItemUpdate } from "../../orchestration/role-calls/work-plan-contracts.js";
import { parseModelWorkPlanItemUpdates } from "../../orchestration/role-calls/work-plan-validation.js";

export type ExecutionWorkPlanReport = Readonly<{
  mode: "adopt" | "progress";
  sourceResultRef: string;
  itemUpdates: readonly ModelWorkPlanItemUpdate[];
}>;
export type ExecutionWorkPlanSource = Readonly<{
  sourceResultRef: string;
  itemIds: readonly string[];
}>;
export type ExecutionWorkPlanOptions = Readonly<{
  sources: readonly ExecutionWorkPlanSource[];
  current?: ExecutionWorkPlanSource;
}>;

/** Parse only offered canonical identities. The model cannot author a new definition here. */
export function parseExecutionWorkPlanReport(
  value: unknown,
  options?: ExecutionWorkPlanOptions,
): ExecutionWorkPlanReport | undefined {
  if (!options || !isRecord(value)) return undefined;
  if (!exactKeys(value, ["mode", "sourceResultRef"], ["itemUpdates"]))
    return undefined;
  if (value.mode !== "adopt" && value.mode !== "progress") return undefined;
  const source = resolveOfferedWorkPlanSource(
    value.mode,
    value.sourceResultRef,
    options,
  );
  if (!source) return undefined;
  const itemUpdates = parseModelWorkPlanItemUpdates(value.itemUpdates ?? []);
  if (!itemUpdates || (value.mode === "progress" && itemUpdates.length === 0))
    return undefined;
  if (itemUpdates.some((item) => !source.itemIds.includes(item.itemId)))
    return undefined;
  return {
    mode: value.mode,
    sourceResultRef: source.sourceResultRef,
    itemUpdates,
  };
}

function resolveOfferedWorkPlanSource(
  mode: "adopt" | "progress",
  sourceResultRef: unknown,
  options: ExecutionWorkPlanOptions,
): ExecutionWorkPlanSource | undefined {
  if (mode === "adopt")
    return options.sources.find(
      (candidate) => candidate.sourceResultRef === sourceResultRef,
    );
  if (options.current?.sourceResultRef !== sourceResultRef) return undefined;
  return options.current;
}
