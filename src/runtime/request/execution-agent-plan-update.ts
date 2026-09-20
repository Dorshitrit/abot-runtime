import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { ModelWorkPlanUpdate } from "../orchestration/role-calls/work-plan-contracts.js";
import {
  parseExecutionWorkPlanReport,
  type ExecutionWorkPlanReport,
} from "../steps/execution-agent/work-plan-contract.js";
import {
  projectExecutionWorkPlanOptions,
  resolveExecutionWorkPlanDefinition,
} from "../steps/execution-agent/work-plan-sources.js";

export function bindExecutionAgentPlanUpdate(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  report: ExecutionWorkPlanReport,
): ModelWorkPlanUpdate {
  const validated = parseExecutionWorkPlanReport(
    report,
    projectExecutionWorkPlanOptions(head, call),
  );
  if (!validated) throw new Error("execution_agent_work_plan_report_invalid");
  if (validated.mode === "progress") return { ...validated, mode: "progress" };
  const definition = resolveExecutionWorkPlanDefinition(
    head,
    call,
    validated.sourceResultRef,
  );
  if (!definition) throw new Error("execution_agent_work_plan_source_invalid");
  return { ...validated, mode: "adopt", definition };
}
