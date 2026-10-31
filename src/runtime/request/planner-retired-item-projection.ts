import type { RoleCallPlanState } from "../orchestration/role-calls/index.js";
import type { RequestPlanProjectionState } from "./plan-event-projection.js";

/** Keep the client status contract: retired work remains visibly unperformed.
 * Only canonical ledger state controls scheduling; client "pending" cannot resume it.
 */
export function projectPlannerRetiredItems(
  plan: RoleCallPlanState,
): NonNullable<RequestPlanProjectionState["plan"]> {
  return Object.freeze({
    definition: plan.definition,
    itemStates: Object.freeze(
      plan.itemStates.map((item) => ({
        itemId: item.itemId,
        status: item.status === "retired" ? ("pending" as const) : item.status,
      })),
    ),
  });
}
