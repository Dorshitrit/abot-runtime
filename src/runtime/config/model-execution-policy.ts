import {
  buildModelPluginConfig,
  type RuntimeModelPluginConfig,
} from "./model-plugin-config.js";
import { isRecord } from "./utils.js";
import { isRequestExecutionPolicyId, type RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
export { REQUEST_EXECUTION_POLICY_IDS, DEFAULT_REQUEST_EXECUTION_POLICY_ID,
  isRequestExecutionPolicyId, type RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";

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
