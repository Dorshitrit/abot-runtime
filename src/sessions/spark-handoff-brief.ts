/** Fits the existing assistant conversation content bound without truncation. */
export const MAX_SPARK_HANDOFF_BRIEF_CHARACTERS = 4000;

export function isSparkHandoffBrief(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return value.length <= MAX_SPARK_HANDOFF_BRIEF_CHARACTERS;
}
