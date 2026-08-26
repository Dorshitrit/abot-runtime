import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { MODEL_STEPS } from "../../../shared/model-steps.js";

export const DEGRADED_FINALIZATION_STEP_ID =
  MODEL_STEPS.DEGRADED_FINALIZATION;

export type DegradedFinalizationProblem = Readonly<{
  stage: string;
  code: string;
}>;

export type DegradedFinalizationWorkItem = Readonly<{
  id: string;
  title: string;
}>;

export type DegradedFinalizationUnresolvedWorkItem =
  DegradedFinalizationWorkItem & {
    status: string;
  };

export type DegradedFinalizationProgress = Readonly<{
  planSummary: string;
  completed: readonly DegradedFinalizationWorkItem[];
  unresolved: readonly DegradedFinalizationUnresolvedWorkItem[];
}>;

export type DegradedFinalizationInput = Readonly<{
  problem: DegradedFinalizationProblem;
  progress: DegradedFinalizationProgress | null;
}>;

export type DegradedFinalizationPhrasing = Readonly<{
  failureNotice: string;
  nextStep: string;
}>;

export function createDegradedFinalizationFormat(): ModelGatewayJsonSchemaFormat {
  return {
    type: "json_schema",
    name: "degraded_finalization",
    strict: true,
    schema: {
      type: "object",
      properties: {
        failureNotice: {
          type: "string",
          minLength: 1,
          description:
            "Neutral notice that the runtime could not safely complete the request. It must not describe work progress.",
        },
        nextStep: {
          type: "string",
          minLength: 1,
          description:
            "One safe future action for continuing. It must not describe completed or unresolved work.",
        },
      },
      required: ["failureNotice", "nextStep"],
      additionalProperties: false,
    },
  };
}
