/**
 * Optional effective host appearance, scoped only to a HOME workflow.
 * This reference grants no action authority and never adds conversational intent.
 */
export type SparkHomeAppearanceReference = Readonly<{
  source: "saved_appearance" | "appearance_default";
  background: string;
}>;

function isAppearanceReferenceSource(value: unknown): value is SparkHomeAppearanceReference["source"] {
  return value === "saved_appearance" || value === "appearance_default";
}

function hasSparkHomeAppearanceShape(value: unknown): value is SparkHomeAppearanceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 2) return false;
  if (!Object.hasOwn(value, "source")) return false;
  if (!Object.hasOwn(value, "background")) return false;
  const candidate = value as Record<string, unknown>;
  if (!isAppearanceReferenceSource(candidate.source)) return false;
  if (typeof candidate.background !== "string") return false;
  return /^#[0-9a-f]{6}$/i.test(candidate.background);
}

/** Capture a bounded immutable copy at an internal request or restore boundary. */
export function captureSparkHomeAppearanceReference(
  value: unknown,
): SparkHomeAppearanceReference | undefined {
  if (value === undefined) return undefined;
  if (!hasSparkHomeAppearanceShape(value))
    throw new Error("invalid_spark_home_appearance_reference");
  return Object.freeze({
    source: value.source,
    background: value.background.toLowerCase(),
  });
}
