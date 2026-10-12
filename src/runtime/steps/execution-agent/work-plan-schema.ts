import { createStructuredDecisionEnvelopeSchema } from "../../model/structured-decision-envelope.js";
import {
  MODEL_WORK_PLAN_ITEM_LIMIT,
  MODEL_WORK_PLAN_STATUSES,
} from "../../orchestration/role-calls/work-plan-contracts.js";
import type {
  ExecutionWorkPlanOptions,
  ExecutionWorkPlanSource,
} from "./work-plan-contract.js";

const WORK_PLAN_REPORT_DEFINITION = "executionWorkPlanReport";

/** Share report constraints without changing any accepted decision shape. */
export function createExecutionWorkPlanDecisionSchema(
  variants: readonly Record<string, unknown>[],
  options?: ExecutionWorkPlanOptions,
): Record<string, unknown> {
  const reports = createReportSchemas(options);
  if (reports.length === 0)
    return createStructuredDecisionEnvelopeSchema(variants);
  const reportVariants = variants.flatMap((variant) => [
    variant,
    {
      ...variant,
      properties: {
        ...(variant.properties as Record<string, unknown>),
        workPlan: { $ref: `#/$defs/${WORK_PLAN_REPORT_DEFINITION}` },
      },
      required: [...(variant.required as string[]), "workPlan"],
    },
  ]);
  return {
    ...createStructuredDecisionEnvelopeSchema(reportVariants),
    $defs: { [WORK_PLAN_REPORT_DEFINITION]: { anyOf: reports } },
  };
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
