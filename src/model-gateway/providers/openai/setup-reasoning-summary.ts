import { isOpenAIReasoningSummary, type OpenAIReasoningSummary } from "./reasoning-summary-options.js";

export type SetupReasoningSummary = OpenAIReasoningSummary | null;

export function parseSetupReasoningSummary(value: unknown): SetupReasoningSummary | undefined {
  if (value === undefined || value === null) return value;
  if (isOpenAIReasoningSummary(value)) return value;
  throw new Error("Reasoning summary must be auto, concise, detailed, null, or omitted.");
}

export function requireSetupReasoningSummaryProvider(
  provider: string,
  summary: SetupReasoningSummary | undefined,
): void {
  if (summary === undefined || summary === null) return;
  if (provider === "openai") return;
  throw new Error("Reasoning summaries require an OpenAI API provider.");
}

/** Omission preserves saved choices, including dormant options on other providers. */
export function applySetupReasoningSummary(
  profile: Record<string, unknown>,
  provider: string,
  summary: SetupReasoningSummary | undefined,
): void {
  requireSetupReasoningSummaryProvider(provider, summary);
  if (summary === undefined || provider !== "openai") return;
  const previous = profile.options;
  const options = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown> : {};
  profile.options = { ...options, reasoningSummary: summary };
}

/** Hydrate recognized choices without interpreting or rewriting unknown saved values. */
export function readSetupReasoningSummary(
  provider: string,
  options: Readonly<Record<string, unknown>> | undefined,
): SetupReasoningSummary | undefined {
  if (provider !== "openai") return undefined;
  const summary = options?.reasoningSummary;
  if (summary === null) return null;
  if (isOpenAIReasoningSummary(summary)) return summary;
  return undefined;
}
