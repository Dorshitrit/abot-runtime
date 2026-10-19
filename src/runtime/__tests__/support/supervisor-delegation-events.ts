import { expect } from "vitest";
import type { RuntimeDelegateRoleId } from "../../orchestration/roles.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";

/** Verifies the direct assignment before asserting the unchanged lifecycle tail. */
export function expectDirectDelegation(
  events: readonly Parameters<RequestExecutionSeed["onEvent"]>[],
  childRole: RuntimeDelegateRoleId,
  objective: string,
  plannerResult?: string,
) {
  const lifecycleEvents = events.filter(
    ([name]) => name !== "context.window.snapshot",
  );
  expect(lifecycleEvents[0]).toEqual([
    "role.delegated",
    {
      callerCallId: "call-1",
      callerRole: "supervisor",
      childCallId: "call-2",
      childRole,
      objective,
    },
  ]);
  const returns = lifecycleEvents.filter(([name]) => name === "role.returned");
  if (plannerResult === undefined) {
    expect(returns).toEqual([]);
    return lifecycleEvents.slice(1);
  }
  expect(returns).toEqual([
    [
      "role.returned",
      {
        callerCallId: "call-1",
        callerRole: "supervisor",
        childCallId: "call-2",
        childRole: "planner",
        outcome: "completed",
        summary: plannerResult,
      },
    ],
  ]);
  return lifecycleEvents.slice(1).filter(([name]) => name !== "role.returned");
}
