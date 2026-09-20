/** User-selected request authority. Never infer this value from model content. */
export type ToolPermissionMode = "ask" | "full_access" | "full_plus";
export type ToolRequiredPermissionMode = "full_plus";

export function resolveToolPermissionMode(value: unknown): ToolPermissionMode {
  if (value === "full_plus") return "full_plus";
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (mode === "full_access" || mode === "full") return "full_access";
  return "ask";
}

export function permitsRequiredToolMode(
  mode: ToolPermissionMode,
  requiredMode: ToolRequiredPermissionMode | undefined,
): boolean {
  if (requiredMode === undefined) return true;
  return mode === requiredMode;
}

export function requiresToolActionApproval(
  mode: ToolPermissionMode,
  force: boolean,
): boolean {
  if (mode === "full_plus") return false;
  if (force) return true;
  return mode === "ask";
}

export function parseRequiredToolPermissionMode(
  value: unknown,
  path: string,
): ToolRequiredPermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "full_plus") return value;
  throw new Error(`${path} must be full_plus when declared`);
}
