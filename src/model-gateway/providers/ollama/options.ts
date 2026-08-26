export function readEffectiveOption(
  payload: Record<string, unknown>,
  key: "num_ctx" | "num_predict",
): number | undefined {
  const options = payload.options;
  const hasOptionsObject =
    options !== null && typeof options === "object" && !Array.isArray(options);
  if (!hasOptionsObject) {
    return undefined;
  }

  const value = (options as Record<string, unknown>)[key];
  const isPositiveNumber =
    typeof value === "number" && Number.isFinite(value) && value > 0;
  return isPositiveNumber ? Math.floor(value) : undefined;
}
