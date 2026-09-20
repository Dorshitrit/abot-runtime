import type {
  RoleCallTransactionInput,
  RoleCallTransactionResult,
} from "./contracts.js";

export const MODEL_WORK_PLAN_ITEM_LIMIT = 16;
export const MODEL_WORK_PLAN_TEXT_LIMIT = 8_192;
export const MODEL_WORK_PLAN_ID_LIMIT = 128;
export const MODEL_WORK_PLAN_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "blocked",
] as const;
export type ModelWorkPlanStatus = (typeof MODEL_WORK_PLAN_STATUSES)[number];

export type ModelWorkPlanItemUpdate = Readonly<{
  itemId: string;
  status: ModelWorkPlanStatus;
}>;
export type ModelWorkPlanDefinition = Readonly<{
  summary: string;
  items: readonly Readonly<{
    itemId: string;
    title: string;
    objective: string;
  }>[];
}>;
/** A root model's report, never execution evidence or terminal authority. */
export type AdoptedModelWorkPlan = Readonly<{
  sourceResultRef: string;
  definition: ModelWorkPlanDefinition;
  itemStates: readonly ModelWorkPlanItemUpdate[];
}>;
export type ModelWorkPlanUpdate =
  | Readonly<{
      mode: "adopt";
      sourceResultRef: string;
      definition: ModelWorkPlanDefinition;
      itemUpdates: readonly ModelWorkPlanItemUpdate[];
    }>
  | Readonly<{
      mode: "progress";
      sourceResultRef: string;
      itemUpdates: readonly ModelWorkPlanItemUpdate[];
    }>;
export type UpdateModelWorkPlanCommand = Readonly<{
  authority: "active_role";
  type: "update_model_work_plan";
  callId: string;
  invocationAttempt: number;
  update: ModelWorkPlanUpdate;
}>;
export type ModelWorkPlanCommitEffect = Readonly<{
  type: "model_work_plan_updated";
  callId: string;
}>;
export type ModelWorkPlanTransactions = Readonly<{
  updateModelWorkPlan(
    input: RoleCallTransactionInput<UpdateModelWorkPlanCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "model_work_plan_updated",
      "model_work_plan_transition_invalid"
    >
  >;
}>;
