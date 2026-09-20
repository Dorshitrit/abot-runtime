import {
  createRoleCallLedger,
  resolveRoleCallTransactions,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type ExecutionPolicyAuthoritySnapshot,
} from "../../orchestration/role-calls/index.js";
import type {
  ModelWorkPlanDefinition,
  ModelWorkPlanUpdate,
} from "../../orchestration/role-calls/work-plan-contracts.js";
import type { RequestPlanClientEvent } from "../../request/plan-event-projection.js";
import { attachRequestPlannerRoleCallEvents } from "../../request/role-call-planner-events.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../../request/role-executor-composition.js";

import { createModelWorkPlanAdvisorySummary } from "./model-work-plan-proposal-fixture.js";

export const EVENT_WORK_PLAN: ModelWorkPlanDefinition = {
  summary: "Prepare the requested release.",
  items: [
    {
      itemId: "write",
      title: "Write release",
      objective: "Produce the release artifact.",
    },
    {
      itemId: "verify",
      title: "Verify release",
      objective: "Verify the completed artifact.",
    },
    {
      itemId: "deliver",
      title: "Deliver release",
      objective: "Deliver the verified artifact.",
    },
  ],
};

export async function createModelWorkPlanEventFixture(
  authority: ExecutionPolicyAuthoritySnapshot = EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
) {
  const events: RequestPlanClientEvent[] = [];
  const ledger = createRoleCallLedger({
    requestId: "request-1",
    policy: {
      authority,
      limits: {
        maxDepth: 4,
        maxCalls: 12,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  attachRequestPlannerRoleCallEvents({
    ledger,
    onEvent: (name, payload) => events.push({ name, payload }),
  });
  const transactions = resolveRoleCallTransactions(ledger);
  const root = await transactions.createRoot({
    expectedHead: ledger.current(),
  });
  if (!root.ok)
    throw new Error(`work_plan_fixture_root_failed:${root.issueCode}`);
  async function returnSource(
    source: string | ModelWorkPlanDefinition = EVENT_WORK_PLAN,
  ) {
    const callerCallId = ledger.current().state.rootCallId!;
    const opened = await transactions.openChild({
      expectedHead: ledger.current(),
      callerCallId,
      roleId: "planner",
      objective: "Propose a bounded release plan.",
    });
    if (!opened.ok)
      throw new Error(`work_plan_fixture_open_failed:${opened.issueCode}`);
    const returned = await transactions.returnChild({
      expectedHead: ledger.current(),
      callerCallId,
      childCallId: opened.commit.effect.childCallId,
      outcome: "completed",
      summary:
        typeof source === "string"
          ? source
          : createModelWorkPlanAdvisorySummary(
              opened.commit.effect.childCallId,
              source,
            ),
    });
    if (!returned.ok)
      throw new Error(`work_plan_fixture_return_failed:${returned.issueCode}`);
    return returned.commit.effect.resultRef;
  }
  function update(update: ModelWorkPlanUpdate) {
    const head = ledger.current();
    const call = head.state.calls.find(
      ({ callId }) => callId === head.state.rootCallId,
    );
    if (!call) throw new Error("work_plan_fixture_root_missing");
    return transactions.updateModelWorkPlan({
      expectedHead: head,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      update,
    });
  }
  return { ledger, events, returnSource, update };
}

export function liveModelWorkPlanEvents(
  events: readonly RequestPlanClientEvent[],
) {
  return events.map(({ name, payload }, index) => ({
    type: "event",
    name,
    requestId: "request-1",
    sessionId: "session-1",
    seqNo: index + 1,
    eventSequence: index + 1,
    ...payload,
  }));
}

export function persistedModelWorkPlanEvents(
  events: readonly RequestPlanClientEvent[],
) {
  return events.map(({ name, payload }, index) => ({
    type: "event",
    name,
    requestId: "request-1",
    sessionId: "session-1",
    seqNo: index + 1,
    eventSequence: index + 1,
    payload,
  }));
}
