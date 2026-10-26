import type { ModelGatewayPolicyConfig } from "../../../model-gateway/types.js";
import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../../orchestration/role-calls/contracts.js";
import { hasSuperContextContract } from "../super-context-policy.js";

type CompactionConfiguration = Readonly<{
  runnerConfig: RequestRunnerConfig;
  modelPolicy?: ModelGatewayPolicyConfig;
}>;

const SUPER_COMPACTION_STEPS = Object.freeze([
  MODEL_STEPS.SUPER_COMPACTION_COVERAGE,
  MODEL_STEPS.SUPER_COMPACTION_CONTENT,
  MODEL_STEPS.SUPER_COMPACTION_MERGE,
  MODEL_STEPS.SUPER_COMPACTION_CONTINUATION,
]);

/** Preserve existing compactor selection and timeout in this frozen SUPER request only. */
export function projectSuperCompactionConfiguration(
  configuration: CompactionConfiguration,
  authority: ExecutionPolicyAuthoritySnapshot,
): CompactionConfiguration {
  if (!hasSuperContextContract(authority, "supervisor")) return configuration;
  const { runnerConfig, modelPolicy } = configuration;
  const legacyStep = runnerConfig.steps[MODEL_STEPS.CONTEXT_COMPACTION];
  if (!legacyStep) throw new Error("super_compaction_timeout_config_missing");
  const steps = { ...runnerConfig.steps };
  const targets = { ...runnerConfig.models.defaults.steps };
  const policyTargets = { ...modelPolicy?.defaults?.steps };
  const legacyTarget =
    policyTargets[MODEL_STEPS.CONTEXT_COMPACTION] ??
    targets[MODEL_STEPS.CONTEXT_COMPACTION] ??
    MODEL_STEPS.CONTEXT_COMPACTION;
  for (const step of SUPER_COMPACTION_STEPS) {
    const target = policyTargets[step] ?? targets[step] ?? step;
    targets[step] = target;
    policyTargets[step] = target;
    if (inheritsCompactionCalibration(step, target, modelPolicy)) {
      targets[step] = legacyTarget;
      policyTargets[step] = legacyTarget;
    }
    steps[step] = {
      ...steps[step],
      timeoutMs: Math.min(
        steps[step]?.timeoutMs ?? legacyStep.timeoutMs,
        legacyStep.timeoutMs,
      ),
    };
  }
  return Object.freeze({
    runnerConfig: {
      ...runnerConfig,
      models: {
        ...runnerConfig.models,
        defaults: { ...runnerConfig.models.defaults, steps: targets },
      },
      steps,
    },
    ...(modelPolicy
      ? {
          modelPolicy: {
            ...modelPolicy,
            defaults: { ...modelPolicy.defaults, steps: policyTargets },
          },
        }
      : {}),
  });
}

function inheritsCompactionCalibration(
  step: string,
  target: string | undefined,
  policy: ModelGatewayPolicyConfig | undefined,
): boolean {
  if (target !== undefined && target !== step) return false;
  if (policy?.profiles?.[step] || policy?.invocationProfiles?.[step])
    return false;
  if (
    Object.values(policy?.profiles ?? {}).some(
      (profile) => profile.calibration?.[step] !== undefined,
    )
  )
    return false;
  return true;
}
