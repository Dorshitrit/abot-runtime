import {
  projectRequestPlanCommit,
  type RequestPlanClientEvent,
  type RequestPlanProjectionState,
} from "./plan-event-projection.js";
import { consumeUnexpectedThenable } from "../orchestration/synchronous-boundary.js";
import type {
  RoleCallLedger,
  RoleCallLedgerCommit,
  RoleCallLedgerCommitResult,
  RoleCallState,
} from "../orchestration/role-calls/index.js";
import { createRequestPlanEventPresentation } from "./planner-plan-events.js";
import {
  traceRequestPlannerEventsEmitted,
  traceRequestPlannerEventsFailed,
  traceRequestPlannerEventsProjected,
} from "./role-call-planner-event-diagnostics.js";

type CommittedRoleCallTransition = Extract<
  RoleCallLedgerCommitResult,
  { ok: true }
>;

const REQUEST_PLANNER_EVENT_EMISSION_FAILURE_MESSAGE =
  "One or more canonical Planner plan events could not be emitted.";

const ROLE_CALL_PLAN_EVENT_PRESENTATION = createRequestPlanEventPresentation({
  emissionFailureMessage: REQUEST_PLANNER_EVENT_EMISSION_FAILURE_MESSAGE,
});

/**
 * Projects only the client-visible top-level Planner's already-committed
 * canonical plan. It never proposes work or changes role-call state.
 */
export function projectRequestPlannerRoleCallCommit(
  commit: CommittedRoleCallTransition,
): readonly RequestPlanClientEvent[] {
  if (
    commit.effect.type !== "child_opened" &&
    commit.effect.type !== "child_returned"
  ) {
    return Object.freeze([]);
  }
  const effect = commit.effect;
  const caller = commit.head.state.calls.find(
    (call) => call.callId === effect.callerCallId,
  );
  const returnedChild =
    effect.type === "child_returned"
      ? commit.head.state.calls.find(
          (call) => call.callId === effect.childCallId,
        )
      : undefined;
  const planner =
    caller?.roleId === "planner"
      ? caller
      : returnedChild?.roleId === "planner"
        ? returnedChild
        : undefined;
  const plannerCallId = planner?.callId;
  if (
    !plannerCallId ||
    planner.depth !== 1 ||
    planner.parentCallId !== commit.head.state.rootCallId
  ) {
    return Object.freeze([]);
  }
  return projectRequestPlanCommit({
    previousState: projectPlannerPlanState(
      commit.previousHead.state,
      plannerCallId,
    ),
    state: projectPlannerPlanState(commit.head.state, plannerCallId),
    presentation: ROLE_CALL_PLAN_EVENT_PRESENTATION,
  });
}

/**
 * Attaches client presentation to canonical role-call commits. This observer
 * cannot select roles or advance the ledger.
 */
export function attachRequestPlannerRoleCallEvents(
  params: Readonly<{
    ledger: RoleCallLedger;
    onEvent(name: string, payload: Record<string, unknown>): void;
  }>,
): void {
  const commits = params.ledger?.commits;
  const subscribe = commits?.subscribe;
  if (typeof subscribe !== "function" || typeof params.onEvent !== "function") {
    throw new TypeError(
      "Request Planner events require a role-call commit channel and event sink.",
    );
  }

  Reflect.apply(subscribe, commits, [
    (commit: RoleCallLedgerCommit) => {
      let events: readonly RequestPlanClientEvent[];
      try {
        events = projectRequestPlannerRoleCallCommit(commit);
      } catch (error) {
        traceRequestPlannerEventsFailed({
          commit,
          failureStage: "project",
          error,
        });
        throw error;
      }
      if (events.length === 0) return;

      traceRequestPlannerEventsProjected({ commit, events });
      let failed = false;
      for (const event of events) {
        try {
          const result = Reflect.apply(params.onEvent, undefined, [
            event.name,
            event.payload,
          ]);
          if (consumeUnexpectedThenable(result)) {
            failed = true;
            traceRequestPlannerEventsFailed({
              commit,
              failureStage: "emit",
              eventName: event.name,
              error: new TypeError(
                "Request Planner event sink must be synchronous.",
              ),
            });
          }
        } catch (error) {
          failed = true;
          traceRequestPlannerEventsFailed({
            commit,
            failureStage: "emit",
            eventName: event.name,
            error,
          });
        }
      }
      if (failed) {
        throw new TypeError(REQUEST_PLANNER_EVENT_EMISSION_FAILURE_MESSAGE);
      }
      traceRequestPlannerEventsEmitted({ commit, events });
    },
  ]);
}

function projectPlannerPlanState(
  state: RoleCallState,
  plannerCallId: string,
): RequestPlanProjectionState {
  const plan = state.plans.find(
    (candidate) => candidate.definition.plannerCallId === plannerCallId,
  );
  return plan ? Object.freeze({ plan }) : Object.freeze({});
}
