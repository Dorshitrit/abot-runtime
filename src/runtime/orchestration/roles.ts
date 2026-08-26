export const RUNTIME_ROOT_ROLE_ID = "supervisor" as const;
export const RUNTIME_DELEGATE_ROLE_IDS = Object.freeze([
  "planner",
  "worker",
  "researcher",
  "reviewer",
] as const);
export const RUNTIME_ROLE_IDS = Object.freeze([
  RUNTIME_ROOT_ROLE_ID,
  ...RUNTIME_DELEGATE_ROLE_IDS,
] as const);

export type RuntimeRootRoleId = typeof RUNTIME_ROOT_ROLE_ID;
export type RuntimeDelegateRoleId = (typeof RUNTIME_DELEGATE_ROLE_IDS)[number];
export type RuntimeRoleId = (typeof RUNTIME_ROLE_IDS)[number];

export function isRuntimeDelegateRoleId(
  value: unknown,
): value is RuntimeDelegateRoleId {
  return (
    typeof value === "string" &&
    (RUNTIME_DELEGATE_ROLE_IDS as readonly string[]).includes(value)
  );
}
