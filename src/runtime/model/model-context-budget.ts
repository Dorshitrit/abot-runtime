import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type {
  ModelGatewayFormat,
  ModelGatewayPolicyConfig,
  ModelPreference,
  ResolvedModelInvocation,
} from "../../model-gateway/types.js";
import type { AgentMode } from "../../shared/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { estimateConfiguredStepInstructionReserveTokens } from "../config/runner/step-instructions.js";
import type { RequestContextBudget } from "../context/request-context-contracts.js";

export function resolveModelContextBudget(params: {
  runnerConfig: RequestRunnerConfig;
  agentMode: AgentMode;
  modelStep: ModelStep;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
}): RequestContextBudget {
  const admission = resolveModelContextAdmission(params);
  const configuredInstructionReserveTokens =
    estimateConfiguredStepInstructionReserveTokens({
      runnerConfig: params.runnerConfig,
      modelStep: params.modelStep,
      ...(admission.budget.tokenEstimation
        ? { tokenEstimation: admission.budget.tokenEstimation }
        : {}),
    });
  return configuredInstructionReserveTokens > 0
    ? Object.freeze({
        ...admission.budget,
        configuredInstructionReserveTokens,
      })
    : admission.budget;
}

export type ResolvedModelContextAdmission = Readonly<{
  invocation: ResolvedModelInvocation;
  budget: RequestContextBudget;
  effectiveFormat?: ModelGatewayFormat;
}>;

export function resolveModelContextAdmission(params: {
  runnerConfig: RequestRunnerConfig;
  agentMode: AgentMode;
  modelStep: ModelStep;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  requestFormat?: ModelGatewayFormat;
}): ResolvedModelContextAdmission {
  const invocation = resolveModelInvocation({
    agentMode: params.agentMode,
    modelStep: params.modelStep,
    ...(params.modelPreference
      ? { modelPreference: params.modelPreference }
      : {}),
    ...(params.modelPolicy ? { modelPolicy: params.modelPolicy } : {}),
  });
  const formatTokenAccounting =
    invocation.profile.context.formatTokenAccounting;

  const budget = Object.freeze({
    contextWindowTokens: invocation.profile.contextWindowTokens,
    outputReserveTokens: params.runnerConfig.context.outputReserveTokens,
    safetyReserveTokens: params.runnerConfig.context.safetyReserveTokens,
    attachmentReserveTokens:
      params.runnerConfig.context.attachmentReserveTokens,
    formatTokenAccounting: {
      mode: formatTokenAccounting?.mode ?? "estimate",
      ...(formatTokenAccounting?.fixedOverheadTokens !== undefined
        ? { fixedOverheadTokens: formatTokenAccounting.fixedOverheadTokens }
        : {}),
    },
    ...(invocation.profile.context.tokenEstimation
      ? { tokenEstimation: invocation.profile.context.tokenEstimation }
      : {}),
  });
  return Object.freeze({
    invocation,
    budget,
    ...((params.requestFormat ?? invocation.format)
      ? { effectiveFormat: params.requestFormat ?? invocation.format }
      : {}),
  });
}
