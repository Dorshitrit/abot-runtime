/** A reasoning-only limit; never a context capacity or total-output limit. */
export type ModelReasoningBudget = Readonly<
  { mode: "tokens"; tokens: number } | { mode: "server-default" }
>;

/** Captured per request; omission inherits the selected profile's policy. */
export type ModelReasoningPreference = Readonly<
  | { profileId: string; mode: "off" }
  | { profileId: string; mode: "server-default" }
  | { profileId: string; mode: "budget"; budgetTokens: number }
>;

// llama.cpp's wire counter is a signed 32-bit integer. Native sentinel values
// stay in its adapter; zero disables reasoning and positive budgets limit it.
export const MAX_REASONING_BUDGET_TOKENS = 2_147_483_647;

export class ModelReasoningConfigurationError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ModelReasoningConfigurationError";
  }
}

function isReasoningRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}

export function isFiniteReasoningBudgetTokens(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isInteger(value)) return false;
  if (value < 0) return false;
  return value <= MAX_REASONING_BUDGET_TOKENS;
}

function hasOnlyReasoningFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasBudgetModeFields(value: Record<string, unknown>): boolean {
  if (value.mode === "server-default")
    return hasOnlyReasoningFields(value, ["mode"]);
  return hasOnlyReasoningFields(value, ["mode", "tokens"]);
}

function hasPreferenceModeFields(value: Record<string, unknown>): boolean {
  if (value.mode === "budget")
    return hasOnlyReasoningFields(value, ["profileId", "mode", "budgetTokens"]);
  return hasOnlyReasoningFields(value, ["profileId", "mode"]);
}

export function parseModelReasoningBudget(
  value: unknown,
): ModelReasoningBudget | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw new ModelReasoningConfigurationError(
      "invalid_reasoning_budget",
      "expected server-default or tokens with a non-negative 32-bit integer; zero disables thinking",
    );
  };
  if (!isReasoningRecord(value)) return fail();
  if (!hasBudgetModeFields(value)) return fail();
  if (value.mode === "server-default")
    return Object.freeze({ mode: "server-default" });
  if (value.mode !== "tokens") return fail();
  if (!isFiniteReasoningBudgetTokens(value.tokens)) return fail();
  return Object.freeze({ mode: "tokens", tokens: value.tokens });
}

export function parseModelReasoningPreference(
  value: unknown,
): ModelReasoningPreference | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw new ModelReasoningConfigurationError(
      "invalid_reasoning_preference",
      "expected a profile-bound off, server-default, or non-negative token budget",
    );
  };
  if (!isReasoningRecord(value)) return fail();
  if (typeof value.profileId !== "string") return fail();
  const profileId = value.profileId.trim();
  if (!profileId) return fail();
  if (!hasPreferenceModeFields(value)) return fail();
  if (value.mode === "off" || value.mode === "server-default")
    return Object.freeze({ profileId, mode: value.mode });
  if (value.mode !== "budget") return fail();
  if (!isFiniteReasoningBudgetTokens(value.budgetTokens)) return fail();
  return Object.freeze({
    profileId,
    mode: "budget",
    budgetTokens: value.budgetTokens,
  });
}

/** Capability of the built-in transport plus the model's explicit declaration. */
export function supportsModelReasoningBudget(profile: {
  provider: string;
  supportsThinking?: boolean;
}): boolean {
  if (profile.provider !== "llamacpp") return false;
  return profile.supportsThinking === true;
}

/** Jobs, workflow nodes and request snapshots retain the original profile binding. */
export function parseBoundModelReasoningPreference(
  value: unknown,
  profileId: string,
): ModelReasoningPreference | undefined {
  const preference = parseModelReasoningPreference(value);
  if (!preference) return undefined;
  if (preference.profileId !== profileId) {
    throw new ModelReasoningConfigurationError(
      "reasoning_preference_profile_mismatch",
      "reasoning preference must bind the selected model profile",
    );
  }
  return preference;
}
