import {
  composeRoleCallPlanChildObjective,
  createRoleCallReviewerVerdictReceipt,
  projectRoleChildReturnContext,
  type RoleCallLedger,
} from "../../orchestration/role-calls/index.js";
import { projectRootMemoryRecallMessage } from "../../long-term-memory/recall-context.js";
import { boundMemoryRecallResult } from "../../long-term-memory/recall-result.js";
import { MEMORY_RECORD } from "./memory-recall-runner.js";

export const ROOT_REQUEST = "Write source markers to explicit-new-target.txt.";
export const HISTORY_FACT =
  "Original deployment was east; corrected deployment is west.";
export const LATEST_CORRECTION = "Latest correction: the deployment is north.";
export const ACTIVE_FACT =
  "SOURCE_MARKER_ALPHA: source observation remains required.";
export const RECALL_FACT =
  "Earlier work used historical-target.txt; it is passive reference.";

async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result;
}

export async function settleRootEvidence(
  ledger: RoleCallLedger,
  options: Readonly<{
    executionAgent: boolean;
    batch?: boolean;
    fullChain?: boolean;
  }>,
) {
  if (options.executionAgent) {
    const entries = [
      "source.txt",
      ...(options.batch ? ["second-source.txt"] : []),
    ].map((path) => ({
      capabilityId: "files.read",
      declaredEffect: "observation",
      intent: "Read source",
      controlsJson: JSON.stringify({ path }),
    }));
    const begin = options.batch
      ? { type: "begin_capability_batch", entries }
      : { type: "begin_capability_execution", ...entries[0] };
    await commit(ledger, {
      authority: "active_role",
      callId: "call-1",
      invocationAttempt: 1,
      ...begin,
    });
    const settlements = entries.map((_, index) => ({
      executionId: `capability-execution-${index + 1}`,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: ACTIVE_FACT,
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: { content: `${ACTIVE_FACT} ${"source detail ".repeat(180)}` },
      },
    }));
    const settle = options.batch
      ? { type: "settle_capability_batch", settlements }
      : { type: "settle_capability_execution", ...settlements[0] };
    await commit(ledger, { authority: "runtime", callId: "call-1", ...settle });
    return undefined;
  }
  if (!options.fullChain) {
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Read source.txt",
      workingDirectory: ".",
    });
    return projectRoleChildReturnContext(
      ledger,
      await commit(ledger, {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: `${ACTIVE_FACT} ${"source detail ".repeat(180)}`,
      }),
    );
  }
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: ROOT_REQUEST,
    workingDirectory: ".",
  });
  const planItems = [{ title: "Read source", objective: "Read source.txt" }];
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective: composeRoleCallPlanChildObjective(planItems, 16000),
    plannerPlan: {
      mode: "declare",
      plan: { summary: "Inspect source", items: planItems },
      selectedItemIndexes: [0],
    },
  });
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-2",
    childCallId: "call-3",
    outcome: "completed",
    summary: ACTIVE_FACT,
  });
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-2",
    outcome: "completed",
    summary: ACTIVE_FACT,
  });
  const plannerResult = ledger.current().state.results.at(-1)!;
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: ROOT_REQUEST,
    dependencyResultRefs: [plannerResult.resultRef],
  });
  const head = ledger.current();
  return projectRoleChildReturnContext(
    ledger,
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-4",
      outcome: "completed",
      summary: `${ACTIVE_FACT} ${"source detail ".repeat(180)}`,
      receipt: createRoleCallReviewerVerdictReceipt({
        reviewerCallId: "call-4",
        callerCallId: "call-1",
        reviewScopeId: `review:call-4:r${head.revision}`,
        sourceRevision: head.revision,
        verdict: "pass",
        gaps: [],
      }),
    }),
  );
}

export async function settleRootRecall(ledger: RoleCallLedger) {
  const binding = {
    callId: "call-1",
    invocationAttempt: ledger.current().state.calls[0]!.activationCount,
    steeringVersion: 0,
  };
  const begun = await ledger.transactions!.beginMemoryRecall({
    expectedHead: ledger.current(),
    ...binding,
    query: "previous artifact",
  });
  if (!begun.ok) throw new Error(begun.issueCode);
  const settled = await ledger.transactions!.settleMemoryRecall({
    expectedHead: begun.commit.head,
    ...binding,
    recallId: begun.commit.effect.recallId,
    result: boundMemoryRecallResult({
      available: true,
      records: [{ ...MEMORY_RECORD, content: RECALL_FACT }],
    }),
  });
  if (!settled.ok) throw new Error(settled.issueCode);
  return projectRootMemoryRecallMessage({
    head: ledger.current(),
    callId: "call-1",
    steeringVersion: 0,
  });
}
