import {
  buildModelPluginConfig,
  type RuntimeModelPluginConfig,
} from "./model-plugin-config.js";
import { isRecord } from "./utils.js";

export const REQUEST_EXECUTION_POLICY_IDS = [
  "supervisor-worker-v1",
  "execution-agent-v1",
] as const;

export type RequestExecutionPolicyId =
  (typeof REQUEST_EXECUTION_POLICY_IDS)[number];

export const DEFAULT_REQUEST_EXECUTION_POLICY_ID: RequestExecutionPolicyId =
  "supervisor-worker-v1";

export type RuntimeModelExecutionPolicy = Readonly<{
  policy?: RequestExecutionPolicyId;
  plugins?: RuntimeModelPluginConfig;
}>;

export type RuntimeModelExecutionPolicies = Readonly<
  Record<string, RuntimeModelExecutionPolicy>
>;

export type RequestExecutionPolicySelection = Readonly<{
  policy: RequestExecutionPolicyId;
  primaryProfileId?: string;
  plugins?: RuntimeModelPluginConfig;
  source: "model_profile" | "default";
}>;

export function isRequestExecutionPolicyId(
  value: unknown,
): value is RequestExecutionPolicyId {
  return REQUEST_EXECUTION_POLICY_IDS.some((policyId) => policyId === value);
}

export function buildRuntimeModelExecutionPolicy(
  source: Record<string, unknown>,
): RuntimeModelExecutionPolicy | undefined {
  const execution = isRecord(source.execution) ? source.execution : undefined;
  const configuredPolicy = execution?.policy;
  const policy = isRequestExecutionPolicyId(configuredPolicy)
    ? configuredPolicy
    : undefined;
  const plugins = buildModelPluginConfig(source.plugins);
  if (!policy && !plugins) return undefined;
  return {
    ...(policy ? { policy } : {}),
    ...(plugins ? { plugins } : {}),
  };
}
