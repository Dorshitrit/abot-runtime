import type {
  RoleCallPolicy,
  RoleCallState,
  RoleCallTransitionResult,
} from "../contracts.js";
import type {
  AdoptedModelWorkPlan,
  UpdateModelWorkPlanCommand,
} from "../work-plan-contracts.js";
import { updatesNameKnownItems } from "../work-plan-validation.js";
import {
  areModelWorkPlanDefinitionsEqual,
  resolveModelWorkPlanSourceDefinition,
} from "../work-plan-source.js";
import { commit, reject } from "../reducer-primitives.js";
import { replaceCall } from "./call-frame-state.js";

export function updateModelWorkPlan(
  state: RoleCallState,
  command: UpdateModelWorkPlanCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  if (policy.authority.modelWorkPlanAuthority !== "root")
    return reject(state, "model_work_plan_update_invalid");
  const call = state.calls.find(
    (candidate) => candidate.callId === command.callId,
  );
  if (!call || call.callId !== state.rootCallId || call.parentCallId !== null)
    return reject(state, "model_work_plan_update_invalid");
  if (state.activeCallId !== call.callId || call.status !== "active")
    return reject(state, "caller_not_active");
  if (call.activationCount !== command.invocationAttempt)
    return reject(state, "capability_invocation_mismatch");
  const update = command.update;
  const definition = resolveModelWorkPlanSourceDefinition(
    state,
    call,
    update.sourceResultRef,
    policy,
  );
  if (!definition) return reject(state, "model_work_plan_update_invalid");
  const previous = call.adoptedWorkPlan;
  const isCurrentSource = previous?.sourceResultRef === update.sourceResultRef;
  if (update.mode === "progress" && !isCurrentSource)
    return reject(state, "model_work_plan_update_invalid");
  if (
    update.mode === "adopt" &&
    !areModelWorkPlanDefinitionsEqual(update.definition, definition)
  )
    return reject(state, "model_work_plan_update_invalid");
  if (!updatesNameKnownItems(definition, update.itemUpdates))
    return reject(state, "model_work_plan_update_invalid");
  const statusById = new Map(
    isCurrentSource
      ? previous.itemStates.map((item) => [item.itemId, item.status])
      : [],
  );
  for (const item of update.itemUpdates)
    statusById.set(item.itemId, item.status);
  const adoptedWorkPlan: AdoptedModelWorkPlan = {
    sourceResultRef: update.sourceResultRef,
    definition,
    itemStates: definition.items.map((item) => ({
      itemId: item.itemId,
      status: statusById.get(item.itemId) ?? "pending",
    })),
  };
  // A declaration consumes no extra activation and neither settles work nor resets supervision.
  return commit(
    { ...state, calls: replaceCall(state.calls, { ...call, adoptedWorkPlan }) },
    {
      type: "model_work_plan_updated",
      callId: call.callId,
    },
  );
}
