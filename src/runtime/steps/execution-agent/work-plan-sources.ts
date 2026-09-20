import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { ModelWorkPlanDefinition } from "../../orchestration/role-calls/work-plan-contracts.js";
import { resolveModelWorkPlanSourceDefinition } from "../../orchestration/role-calls/work-plan-source.js";
import type { ExecutionWorkPlanOptions } from "./work-plan-contract.js";

export function resolveExecutionWorkPlanDefinition(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  sourceResultRef: string,
): ModelWorkPlanDefinition | undefined {
  return resolveModelWorkPlanSourceDefinition(
    head.state,
    call,
    sourceResultRef,
    head.policy,
  );
}

export function projectExecutionWorkPlanOptions(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): ExecutionWorkPlanOptions | undefined {
  if (head.policy.authority.modelWorkPlanAuthority !== "root") return undefined;
  const sources = head.state.results.flatMap((result) => {
    const definition = resolveExecutionWorkPlanDefinition(
      head,
      call,
      result.resultRef,
    );
    return definition
      ? [
          {
            sourceResultRef: result.resultRef,
            itemIds: definition.items.map((item) => item.itemId),
          },
        ]
      : [];
  });
  const plan = call.adoptedWorkPlan;
  if (sources.length === 0 && !plan) return undefined;
  return {
    sources,
    ...(plan
      ? {
          current: {
            sourceResultRef: plan.sourceResultRef,
            itemIds: plan.definition.items.map((item) => item.itemId),
          },
        }
      : {}),
  };
}

export function projectExecutionWorkPlanContext(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): Record<string, unknown> | undefined {
  const options = projectExecutionWorkPlanOptions(head, call);
  if (!options) return undefined;
  const plan = call.adoptedWorkPlan;
  return {
    authority: "model_reported_progress_not_completion_evidence",
    availableProposals: options.sources,
    ...(plan
      ? {
          adopted: {
            sourceResultRef: plan.sourceResultRef,
            items: plan.itemStates.map((item) => ({
              itemId: item.itemId,
              status: item.status,
            })),
          },
        }
      : {}),
  };
}
