import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { DegradedFinalizationProgress } from "../steps/degraded-finalization/contract.js";
import { buildRequestPlanSnapshot } from "./plan-event-projection.js";

/** Presents recorded plan status only; it neither changes work nor verifies success. */
export function projectInvalidOutputProgress(
  head: RoleCallLedgerHead,
): DegradedFinalizationProgress | null {
  const root = head.state.calls.find(
    (call) => call.callId === head.state.rootCallId,
  );
  const plans = root?.adoptedWorkPlan
    ? [root.adoptedWorkPlan, ...head.state.plans]
    : head.state.plans;
  if (plans.length === 0) return null;
  const items = plans.flatMap((plan) => buildRequestPlanSnapshot(plan).items);
  return {
    planSummary: "",
    completed: items.filter((item) => item.status === "done"),
    unresolved: items.filter((item) => item.status !== "done"),
  };
}
