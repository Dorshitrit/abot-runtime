import type { RoleCallLedger } from "./contracts.js";
import type { ModelWorkPlanTransactions } from "./work-plan-contracts.js";
import { requireEffect } from "./transaction-effect.js";

export function createModelWorkPlanTransactions(
  apply: RoleCallLedger["apply"],
): ModelWorkPlanTransactions {
  return Object.freeze({
    async updateModelWorkPlan(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "active_role",
            type: "update_model_work_plan",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            update: input.update,
          },
        }),
        "model_work_plan_updated",
        "model_work_plan_transition_invalid",
        (effect) => effect.callId === input.callId,
      );
    },
  });
}
