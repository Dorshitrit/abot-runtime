export const REQUEST_EXECUTION_POLICY_IDS = [
  "supervisor-worker-v1",
  "execution-agent-v1",
] as const;

export type RequestExecutionPolicyId =
  (typeof REQUEST_EXECUTION_POLICY_IDS)[number];

export const DEFAULT_REQUEST_EXECUTION_POLICY_ID: RequestExecutionPolicyId =
  "supervisor-worker-v1";

export type RuntimeModelExecutionPolicy = Readonly<{
  policy: RequestExecutionPolicyId;
}>;

export type RuntimeModelExecutionPolicies = Readonly<
  Record<string, RuntimeModelExecutionPolicy>
>;

export type RequestExecutionPolicySelection = Readonly<{
  policy: RequestExecutionPolicyId;
  primaryProfileId?: string;
  source: "model_profile" | "default";
}>;

export function isRequestExecutionPolicyId(
  value: unknown,
): value is RequestExecutionPolicyId {
  return REQUEST_EXECUTION_POLICY_IDS.some((policyId) => policyId === value);
}
