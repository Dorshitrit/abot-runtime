export const REQUEST_EXECUTION_POLICY_IDS = Object.freeze([
  "supervisor-worker-v1",
  "execution-agent-v1",
] as const);

export type RequestExecutionPolicyId = (typeof REQUEST_EXECUTION_POLICY_IDS)[number];

export const DEFAULT_REQUEST_EXECUTION_POLICY_ID: RequestExecutionPolicyId = "supervisor-worker-v1";

export function isRequestExecutionPolicyId(value: unknown): value is RequestExecutionPolicyId {
  return REQUEST_EXECUTION_POLICY_IDS.some((policyId) => policyId === value);
}

/** Route-less consumers keep their own authority; request routes narrow plugin access. */
export function supportsRequestExecutionPolicy(
  declared: readonly RequestExecutionPolicyId[] | undefined,
  selected: string | undefined,
): boolean {
  if (selected === undefined) return true;
  if (declared === undefined) return true;
  return declared.some((policy) => policy === selected);
}

/** An omitted declaration supports every route; a declared list must be explicit. */
export function parseRequestExecutionPolicies(
  value: unknown,
  path: string,
): readonly RequestExecutionPolicyId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > REQUEST_EXECUTION_POLICY_IDS.length) {
    throw new Error(`${path} must be a non-empty array of supported execution policies`);
  }
  if (!value.every(isRequestExecutionPolicyId)) {
    throw new Error(`${path} must use ${REQUEST_EXECUTION_POLICY_IDS.join(" or ")}`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return Object.freeze([...value]);
}
