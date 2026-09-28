/** Role-result text is admitted to model context by the shared token budget. */
export function isRoleCallResultText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
