import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import type {
  ExecutionAgentDecisionContractOptions,
  ExecutionAgentDecisionParseResult,
} from "./contracts.js";
import { parseExecutionWorkPlanReport } from "./work-plan-contract.js";

export function parseDecisionWithWorkPlan(
  text: string,
  options: ExecutionAgentDecisionContractOptions,
  parseAction: (
    text: string,
    options: ExecutionAgentDecisionContractOptions,
  ) => ExecutionAgentDecisionParseResult,
): ExecutionAgentDecisionParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return parseAction(text, options);
  }
  const record = readStructuredDecisionEnvelope(value);
  if (!record || !Object.hasOwn(record, "workPlan"))
    return parseAction(text, options);
  const workPlan = parseExecutionWorkPlanReport(
    record.workPlan,
    options.workPlan,
  );
  if (!workPlan)
    return {
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "execution_agent_work_plan_invalid",
          path: "decision.workPlan",
          message:
            "workPlan must adopt an offered Planner result or update known items of the currently adopted plan.",
        },
      ],
    };
  const { workPlan: _report, ...action } = record;
  const parsed = parseAction(JSON.stringify({ decision: action }), options);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    decision: Object.freeze({
      ...parsed.decision,
      workPlan: Object.freeze(workPlan),
    }),
  };
}
