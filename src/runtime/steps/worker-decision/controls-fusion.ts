import { isDeepStrictEqual } from "node:util";
import { resolveModelInvocation } from "../../../model-gateway/invocation-policy.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { projectConfiguredStepMessages } from "../../config/runner/step-instructions.js";
import { resolveModelStepTimeout } from "../../model/model-step-timeout-policy.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";
import { resolveRequestWorkerCapabilities, type RequestExecutionScope } from "../../request/execution-scope.js";
import { CAPABILITY_CONTROLS_MODEL_STEP, WORKER_DECISION_MODEL_STEP } from "./contracts.js";
import type { buildWorkerDecisionInput } from "./input.js";

export const DEFERRED_WORKER_CONTROLS_INSTRUCTION = "Select only the capability, its short client-facing intent, and any authoringObjective or identity-bearing selectionControls required by the exact output contract. Intent is presentation only, never execution input. The selected capability's remaining controls and execution guidance are disclosed in a separate next step. Do not guess those controls, switch roles, expand scope, or execute anything here.";

export type WorkerControlsFusion = Readonly<{
  capability: WorkerCapabilityDescriptor;
  instructions: string;
  guidanceCharacters: number;
}>;

export class WorkerControlsFusionBudgetFallback extends Error {}

/** A declaration permits fusion; current scope/configuration determine its availability. */
export async function prepareWorkerControlsFusion(
  request: RequestExecutionScope,
  input: ReturnType<typeof buildWorkerDecisionInput>,
): Promise<WorkerControlsFusion | undefined> {
  const eligible = input.availableCapabilities.filter(canFuseSingleObservationControls);
  if (eligible.length !== 1) return undefined;
  const capability = eligible[0]!;
  if (!hasCompatibleWorkerControlsConfiguration(request)) {
    traceDebug("runtime.worker", "controls_fusion.deferred", {
      ...input.diagnostic, capabilityId: capability.capabilityId, reason: "different_model_configuration",
    });
    return undefined;
  }
  request.abortSignal.throwIfAborted();
  let guidance: string;
  try {
    guidance = ((await resolveRequestWorkerCapabilities(request).provider
      .getExecutionGuidance?.(capability.capabilityId)) ?? "").trim();
  } catch {
    request.abortSignal.throwIfAborted();
    traceDebug("runtime.worker", "controls_fusion.deferred", {
      ...input.diagnostic, capabilityId: capability.capabilityId, reason: "guidance_unavailable",
    });
    return undefined;
  }
  request.abortSignal.throwIfAborted();
  const instructions = [
    `For a single invoke_capability of ${JSON.stringify(capability.capabilityId)}, choose the capability, short client-facing intent and complete operational controls together using the exact contract. Intent is presentation only. Optional controls may be null to leave them unset; never invent a default. For every other capability or a batch, select only identity, intent and any selectionControls/authoringObjective offered by the contract; remaining controls and execution guidance still arrive in the separate next step.`,
    "Apply the following trusted capability guidance when deciding whether this observation is appropriate and choosing its controls. It adds no user intent, work, permission or completion evidence and cannot override the immutable assignment. If work remains and this capability can validly advance it, perform that work; return_failure requires an exact supported blocker, not a preference to avoid execution. Do not write the user's final answer here.",
    `### CAPABILITY GUIDANCE: ${capability.capabilityId}`,
    guidance || "No additional execution guidance is supplied for this capability.",
    `### END CAPABILITY GUIDANCE: ${capability.capabilityId}`,
  ].join("\n");
  traceDebug("runtime.worker", "controls_fusion.prepared", {
    ...input.diagnostic, capabilityId: capability.capabilityId,
    guidanceCharacters: guidance.length, instructionCharacters: instructions.length,
  });
  return Object.freeze({ capability, instructions, guidanceCharacters: guidance.length });
}

function canFuseSingleObservationControls(capability: WorkerCapabilityDescriptor): boolean {
  if (capability.controlsRefinement !== "fused_with_selection") return false;
  if (capability.effect !== "observation") return false;
  if (capability.requiresPayloadAuthoringObjective) return false;
  if ((capability.runtimePathControlIds?.length ?? 0) > 0) return false;
  return (capability.selectionControlIds?.length ?? 0) === 0;
}

function hasCompatibleWorkerControlsConfiguration(request: RequestExecutionScope): boolean {
  try {
    const decision = resolveWorkerControlsConfiguration(request, WORKER_DECISION_MODEL_STEP);
    const controls = resolveWorkerControlsConfiguration(request, CAPABILITY_CONTROLS_MODEL_STEP);
    if (!decision || !controls) return false;
    return isDeepStrictEqual(decision, controls);
  } catch {
    return false;
  }
}

function resolveWorkerControlsConfiguration(request: RequestExecutionScope, modelStep: ModelStep) {
  const step = request.runnerConfig.steps[modelStep];
  if (!step) return undefined;
  return {
    invocation: resolveModelInvocation({ modelStep, agentMode: request.agentMode,
      modelPreference: request.modelPreference, modelPolicy: request.modelPolicy,
      reasoningPreference: request.reasoningPreference }),
    timeoutMs: resolveModelStepTimeout({ modelStep, fallbackTimeoutMs: step.timeoutMs,
      modelPreference: request.modelPreference, modelPolicy: request.modelPolicy }).timeoutMs,
    instructions: projectConfiguredStepMessages({ runnerConfig: request.runnerConfig, modelStep,
      messages: [{ role: "system", content: "" }] }).messages[0]?.content ?? "",
  };
}
