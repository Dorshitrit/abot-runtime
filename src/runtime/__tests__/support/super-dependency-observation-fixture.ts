import {
  createRoleCallLedger,
  composeRoleCallPlanChildObjective,
  projectRoleCallDependencyResults,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityExecutionOutcome,
} from "../../orchestration/role-calls/index.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../../context/semantic-compaction/contracts.js";

export const DEPENDENCY_PROMPT = "Use selected research to update the existing application.";
export const SELECTED_SOURCE = 'const selectedApi = "SELECTED_TRANSITIVE_TOOL_ONLY";\n';
export const NESTED_SOURCE = '<main id="NESTED_SELECTED_TOOL_ONLY"></main>\n';
export const UNSELECTED_SOURCE = "UNSELECTED_SIBLING_SECRET";
export const DEPENDENCY_REQUEST_ID = "super-dependency-observations-test";

export async function commitDependencyCommand(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

type ObservationOptions = {
  observedEffect?: RoleCapabilityObservedEffect;
  outcome?: RoleCapabilityExecutionOutcome;
  summary?: string;
};

async function settleFixtureExecution(ledger: RoleCallLedger, stdout: string, options: ObservationOptions = {}) {
  const call = ledger.current().state.calls.find(entry => entry.callId === ledger.current().state.activeCallId)!;
  await commitDependencyCommand(ledger, {
    authority: "active_role", type: "begin_capability_execution",
    callId: call.callId, invocationAttempt: call.activationCount,
    capabilityId: "execute_command", declaredEffect: "mixed",
    intent: "Read the assigned source.", controlsJson: '{"command":"cat assigned-source","cwd":"."}',
    actionFingerprint: hash("read:" + call.callId),
  });
  const executionId = ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  const outcome = options.outcome ?? (options.observedEffect === "none" ? "failed" : "succeeded");
  const summary = options.summary ?? "The assigned source was observed.";
  await commitDependencyCommand(ledger, {
    authority: "runtime", type: "settle_capability_execution",
    callId: call.callId, executionId, outcome,
    observedEffect: options.observedEffect ?? "observation",
    summary,
    exactResult: {
      kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: { ok: outcome === "succeeded", tool: "exec", output: summary, stdout,
        exitCode: outcome === "succeeded" ? 0 : 1, progress: false, producedNewInformation: true },
    },
  });
  return executionId;
}

async function returnFixtureChild(ledger: RoleCallLedger, parentId: string, childId: string) {
  await commitDependencyCommand(ledger, {
    authority: "runtime", type: "return_child", callerCallId: parentId, childCallId: childId,
    outcome: "completed", summary: "Selected work is settled; exact details remain in its tool receipt.",
  });
  return ledger.current().state.results.at(-1)!;
}

async function openRootWorker(ledger: RoleCallLedger, objective: string) {
  await commitDependencyCommand(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker", objective,
  });
  return ledger.current().state.calls.at(-1)!;
}

/** Canonical receipts: selected Planner has its own dependency and a child observation. */
export async function dependencyObservationFixture(options: {
  first?: ObservationOptions;
  nested?: ObservationOptions;
  selectFirstDirectly?: boolean;
} = {}) {
  const policy = resolveRequestExecutionPolicy("supervisor-worker-v1");
  const ledger = createRoleCallLedger({
    requestId: DEPENDENCY_REQUEST_ID,
    policy: { authority: policy.authority,
      limits: { maxDepth: 8, maxCalls: 20, maxCapabilityExecutions: 20,
        maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 } },
  });
  await commitDependencyCommand(ledger, { authority: "runtime", type: "create_root" });
  const firstProducer = await openRootWorker(ledger, "Read the selected JavaScript API.");
  const firstExecutionId = await settleFixtureExecution(ledger, SELECTED_SOURCE, options.first);
  const firstResult = await returnFixtureChild(ledger, "call-1", firstProducer.callId);
  const unselectedProducer = await openRootWorker(ledger, "Inspect an unrelated source.");
  const unselectedExecutionId = await settleFixtureExecution(ledger, UNSELECTED_SOURCE);
  const unselectedResult = await returnFixtureChild(ledger, "call-1", unselectedProducer.callId);
  await commitDependencyCommand(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "planner", objective: "Combine the selected API with the assigned document structure.",
    dependencyResultRefs: [firstResult.resultRef],
  });
  const planner = ledger.current().state.calls.at(-1)!;
  const planItems = [{ title: "Inspect structure", objective: "Read the selected HTML structure." }];
  await commitDependencyCommand(ledger, {
    authority: "active_role", type: "open_child", callerCallId: planner.callId, roleId: "worker",
    objective: composeRoleCallPlanChildObjective(planItems, 8192),
    plannerPlan: { mode: "declare", plan: { summary: "Observe the selected structure.", items: planItems }, selectedItemIndexes: [0] },
  });
  const nestedProducer = ledger.current().state.calls.at(-1)!;
  const nestedExecutionId = await settleFixtureExecution(ledger, NESTED_SOURCE, options.nested);
  const nestedResult = await returnFixtureChild(ledger, planner.callId, nestedProducer.callId);
  const selectedResult = await returnFixtureChild(ledger, "call-1", planner.callId);
  await commitDependencyCommand(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker",
    objective: DEPENDENCY_PROMPT,
    dependencyResultRefs: options.selectFirstDirectly
      ? [selectedResult.resultRef, firstResult.resultRef] : [selectedResult.resultRef],
  });
  const head = ledger.current();
  const consumerCall = head.state.calls.find(entry => entry.callId === head.state.activeCallId)!;
  const dependencyResults = projectRoleCallDependencyResults(head, consumerCall);
  return {
    requestId: DEPENDENCY_REQUEST_ID, prompt: DEPENDENCY_PROMPT, ledger, head, call: consumerCall, consumerCall,
    dependencyResults, firstProducer, firstResult, firstExecutionId,
    unselectedProducer, unselectedResult, unselectedExecutionId,
    planner, nestedProducer, nestedResult, nestedExecutionId, selectedResult,
  };
}

export function cloneDependencyHead(head: RoleCallLedgerHead): RoleCallLedgerHead {
  return JSON.parse(JSON.stringify(head)) as RoleCallLedgerHead;
}
