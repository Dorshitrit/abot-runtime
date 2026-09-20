import { exactKeys, isRecord } from "../../validation/strict-record.js";
import {
  MODEL_WORK_PLAN_ITEM_LIMIT,
  MODEL_WORK_PLAN_STATUSES,
  type ModelWorkPlanItemUpdate,
} from "../../orchestration/role-calls/work-plan-contracts.js";
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

/** Optional metadata uses explicit schema variants; existing variants stay byte-for-byte available. */
export function withExecutionWorkPlanVariants(
  variants: readonly Record<string, unknown>[],
  options?: ExecutionWorkPlanOptions,
): readonly Record<string, unknown>[] {
  const reports = createReportSchemas(options);
  if (reports.length === 0) return variants;
  return variants.flatMap((variant) => [
    variant,
    {
      ...variant,
      properties: {
        ...(variant.properties as Record<string, unknown>),
        workPlan: { anyOf: reports },
      },
      required: [...(variant.required as string[]), "workPlan"],
    },
  ]);
}

function createReportSchemas(
  options?: ExecutionWorkPlanOptions,
): readonly Record<string, unknown>[] {
  if (!options) return [];
  const schemas = options.sources.map((source) =>
    reportSchema("adopt", source),
  );
  if (options.current) schemas.push(reportSchema("progress", options.current));
  return schemas;
}

function reportSchema(
  mode: "adopt" | "progress",
  source: ExecutionWorkPlanSource,
): Record<string, unknown> {
  const itemIds = [...new Set(source.itemIds)];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: [mode] },
      sourceResultRef: {
        type: "string",
        enum: [source.sourceResultRef],
      },
      itemUpdates: {
        type: "array",
        minItems: mode === "progress" ? 1 : 0,
        maxItems: MODEL_WORK_PLAN_ITEM_LIMIT,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            itemId: { type: "string", enum: itemIds },
            status: { type: "string", enum: [...MODEL_WORK_PLAN_STATUSES] },
          },
          required: ["itemId", "status"],
        },
      },
    },
    required: ["mode", "sourceResultRef", "itemUpdates"],
  };
}
