import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";

/** Chat permissions never inherit a browser's last ordinary-session selection. */
export function readSparkToolPermissionMode(value: unknown): ToolPermissionMode {
  if (value === undefined) return "ask";
  if (value === "ask" || value === "full_access" || value === "full_plus") return value;
  throw new Error("invalid_spark_tool_permission_mode");
}
