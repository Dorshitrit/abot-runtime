/** Capability-owned placement of control selection; execution contracts stay unchanged. */
export type ToolControlsRefinement =
  | "mechanical_when_complete"
  | "fused_with_selection";

export function isToolControlsRefinement(
  value: unknown,
): value is ToolControlsRefinement {
  return value === "mechanical_when_complete" || value === "fused_with_selection";
}
