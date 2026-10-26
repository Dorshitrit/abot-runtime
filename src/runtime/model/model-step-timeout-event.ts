import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import type { ResolvedModelStepTimeout } from "./model-step-timeout-policy.js";

export const MODEL_STEP_TIMED_OUT_EVENT = "model.step.timed_out";

export type ModelStepTimeoutIdentity = Readonly<{
  invocationId: string;
  profileId: string;
  provider: string;
  model: string;
}>;

/** Projects only the deadline owned by this attempt, never provider error text. */
export function projectModelStepTimeoutEvent(params: Readonly<{
  requestId: string;
  modelStep: ModelStep;
  identity: ModelStepTimeoutIdentity;
  parentSignal: AbortSignal;
  attemptSignal: AbortSignal;
  configuredTimeoutMs: number;
  timeout: ResolvedModelStepTimeout;
  modelPolicy?: ModelGatewayPolicyConfig;
}>): Record<string, unknown> | undefined {
  if (params.parentSignal.aborted || !params.attemptSignal.aborted) return undefined;
  const reason: unknown = params.attemptSignal.reason;
  if (!(reason instanceof ModelStepTimeoutError)) return undefined;
  if (reason.modelStep !== params.modelStep) return undefined;

  const calibrationSlotId = resolveCalibrationSlot(params);
  return {
    requestId: params.requestId,
    ...params.identity,
    modelStep: params.modelStep,
    timeoutMs: params.timeout.timeoutMs,
    configuredTimeoutMs: params.configuredTimeoutMs,
    timeoutSource: params.timeout.source,
    ...(params.timeout.selectedProfileId
      ? { configurationProfileId: params.timeout.selectedProfileId }
      : {}),
    ...(calibrationSlotId ? { calibrationSlotId } : {}),
  };
}

function resolveCalibrationSlot(params: Readonly<{
  modelStep: ModelStep;
  timeout: ResolvedModelStepTimeout;
  modelPolicy?: ModelGatewayPolicyConfig;
}>): string | undefined {
  if (params.timeout.calibrationSlotId) return params.timeout.calibrationSlotId;
  const slotId = params.modelPolicy?.defaults?.steps?.[params.modelStep];
  if (!slotId) return undefined;
  if (params.modelPolicy?.invocationProfiles?.[slotId]) return undefined;
  if (params.modelPolicy?.profiles?.[slotId]) return undefined;
  return slotId;
}
