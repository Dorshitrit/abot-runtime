import type { RoleCallFrame, RoleCallLedgerHead, RoleCallResult } from "../orchestration/role-calls/contracts.js";
import { normalizeRoleCallWorkResultReceipt, isRoleCallWorkResultReceiptValidForStoredResult } from "../orchestration/role-calls/work-result-receipt.js";
import { projectRoleCallWorkResultLineage } from "../orchestration/role-calls/work-result-lineage.js";
import { projectCanonicalRequestToolResult } from "./canonical-capability-result.js";
import { hasSuperContextContract } from "./super-context-policy.js";
import type { RequestToolResult } from "./request-tool-results.js";

/** Selection is ledger lineage, never a path, command, or model-authored relevance claim. */
export function projectSelectedDependencyObservations(
  head: RoleCallLedgerHead,
  consumer: RoleCallFrame,
  selectedResultRef?: string,
): readonly RequestToolResult[] {
  if (!hasSuperContextContract(head.policy.authority, "delegated.worker")) return Object.freeze([]);
  if (consumer.roleId !== "worker") return Object.freeze([]);
  if (!head.state.calls.includes(consumer)) throw new Error("super_dependency_observation_consumer_invalid");
  const selected = selectedResultRef === undefined ? consumer.dependencyResultRefs : [selectedResultRef];
  if (selected.some((ref) => !consumer.dependencyResultRefs.includes(ref)))
    throw new Error("super_dependency_observation_selection_invalid");
  const results = new Map(head.state.results.map((result) => [result.resultRef, result]));
  const calls = new Map(head.state.calls.map((call) => [call.callId, call]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const selectedCalls = new Set<string>();
  const selectedResults: RoleCallResult[] = [];
  const requireResult = (ref: string): RoleCallResult => {
    const result = results.get(ref);
    if (!result) throw new Error("super_dependency_observation_result_missing");
    return result;
  };
  const visitDependency = (owner: RoleCallFrame, ref: string): void => {
    const result = requireResult(ref);
    const producer = calls.get(result.producerCallId);
    if (!producer || producer.parentCallId !== owner.parentCallId)
      throw new Error("super_dependency_observation_sibling_invalid");
    visit(result);
  };
  const visit = (result: RoleCallResult): void => {
    if (visited.has(result.resultRef)) return;
    if (visiting.has(result.resultRef)) throw new Error("super_dependency_observation_lineage_cycle");
    const producer = calls.get(result.producerCallId);
    if (!producer || producer.status !== "completed" || producer.resultRef !== result.resultRef || producer.roleId !== result.roleId)
      throw new Error("super_dependency_observation_producer_invalid");
    if (producer.roleId !== "worker" && producer.roleId !== "planner") return;
    visiting.add(result.resultRef);
    for (const ref of producer.dependencyResultRefs) visitDependency(producer, ref);
    for (const childId of producer.childCallIds) {
      const child = calls.get(childId);
      if (!child?.resultRef || child.parentCallId !== producer.callId)
        throw new Error("super_dependency_observation_child_invalid");
      visit(requireResult(child.resultRef));
    }
    selectedCalls.add(producer.callId);
    selectedResults.push(result);
    visiting.delete(result.resultRef);
    visited.add(result.resultRef);
  };
  for (const ref of selected) visitDependency(consumer, ref);
  const observations = head.state.capabilityExecutions.filter((execution) =>
    selectedCalls.has(execution.callId) && execution.status === "settled" && execution.observedEffect === "observation");
  // No new data means no new contract requirement for existing summary-only dependencies.
  if (observations.length === 0) return Object.freeze([]);
  for (const result of selectedResults) {
    const producer = calls.get(result.producerCallId)!;
    const receipt = normalizeRoleCallWorkResultReceipt(result.receipt);
    if (!receipt || !isRoleCallWorkResultReceiptValidForStoredResult({ state: head.state, receipt, producer, result, policy: head.policy }))
      throw new Error("super_dependency_observation_receipt_invalid");
    const lineage = projectRoleCallWorkResultLineage({ state: head.state, receipt });
    if (!lineage) throw new Error("super_dependency_observation_lineage_invalid");
    if (observations.some((execution) => execution.callId === producer.callId && !lineage.capabilityExecutionIds.includes(execution.executionId)))
      throw new Error("super_dependency_observation_execution_invalid");
  }
  // Failed observations retain their outcome; declared mixed EXEC reads remain eligible.
  return Object.freeze(observations.map((execution) => projectCanonicalRequestToolResult(head, execution)));
}
