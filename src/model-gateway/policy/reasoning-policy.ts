import { parseModelReasoningBudgetByMode } from "../../shared/model-reasoning-modes.js";
import { resolveReasoningModeBudget } from "./reasoning-mode-budget.js";
import type { ModelReasoningLevel } from "../../shared/types.js";
import { isRegisteredModelStepInLane } from "../../shared/model-step-registry.js";
import {
  ModelReasoningConfigurationError,
  parseModelReasoningBudget,
  parseModelReasoningPreference,
  supportsModelReasoningBudget,
  type ModelReasoningBudget,
  type ModelReasoningPreference,
} from "../../shared/model-reasoning.js";
import type { ModelGatewayRequest, ModelProfile } from "../types.js";
import { resolveProfileById } from "./invocation-profile-policy.js";

export function resolveThink(agentMode: unknown): ModelReasoningLevel {
  const mode = String(agentMode || "reasoning").toLowerCase();
  if (mode === "deep") return "high";
  if (mode === "fast") return "none";
  return "medium";
}

export function normalizeReasoning(
  value: unknown,
): ModelReasoningLevel | undefined {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh") return "xhigh";
  return undefined;
}

function assertReasoningBudgetSupport(profile: ModelProfile): void {
  if (supportsModelReasoningBudget(profile)) return;
  throw new ModelReasoningConfigurationError(
    "reasoning_budget_unsupported",
    `profile ${profile.id} does not declare numeric reasoning controls`,
  );
}

function resolveRequestedPreference(
  request: ModelGatewayRequest,
): ModelReasoningPreference | undefined {
  const preference = parseModelReasoningPreference(request.reasoningPreference);
  if (!preference) return undefined;
  const boundProfile = resolveProfileById(
    preference.profileId,
    request.modelPolicy,
  );
  if (!boundProfile) {
    throw new ModelReasoningConfigurationError(
      "invalid_reasoning_preference",
      `unknown profile ${preference.profileId}`,
    );
  }
  assertReasoningBudgetSupport(boundProfile);
  return preference;
}

function canApplyReasoningPreference(
  request: ModelGatewayRequest,
  profile: ModelProfile,
  preference: ModelReasoningPreference | undefined,
): preference is ModelReasoningPreference {
  if (!preference) return false;
  if (preference.profileId !== profile.id) return false;
  // Calls without a modelStep are direct public gateway calls. Registered
  // utility calls retain their own calibration even when preference.scope=all.
  if (request.modelStep === undefined) return true;
  return isRegisteredModelStepInLane(request.modelStep, "main");
}

function preferenceBudget(
  preference: ModelReasoningPreference,
): ModelReasoningBudget | undefined {
  if (preference.mode === "off") return undefined;
  if (preference.mode === "server-default") return { mode: "server-default" };
  return { mode: "tokens", tokens: preference.budgetTokens };
}

function isZeroReasoningBudget(budget: ModelReasoningBudget | undefined): boolean {
  if (budget?.mode !== "tokens") return false;
  return budget.tokens === 0;
}

export function resolveInvocationReasoning(
  request: ModelGatewayRequest,
  profile: ModelProfile,
): {
  think?: ModelReasoningLevel;
  reasoningBudget?: ModelReasoningBudget;
  reasoningControlSource?:
    | "invocation"
    | "request"
    | "configuration"
    | "agent-mode";
} {
  const preference = resolveRequestedPreference(request);
  const applies = canApplyReasoningPreference(request, profile, preference);
  const configuredBudget = parseModelReasoningBudget(
    profile.generation.reasoningBudget,
  );
  const configuredModes = parseModelReasoningBudgetByMode(
    profile.generation.reasoningBudgetByMode,
  );
  if (configuredBudget || configuredModes)
    assertReasoningBudgetSupport(profile);
  const modeBudget = resolveReasoningModeBudget(request, configuredModes);
  const override = normalizeReasoning(request.reasoningOverride);
  const configuredThink =
    profile.generation.reasoningEffort ?? resolveThink(request.agentMode);
  const preferredEffort = resolvePreferredEffort(
    applies ? preference : undefined,
    configuredThink,
  );
  const budget = applies
    ? preferenceBudget(preference)
    : (modeBudget ?? configuredBudget);
  const zeroBudgetDisablesThinking = isZeroReasoningBudget(budget);
  const budgetEffort = zeroBudgetDisablesThinking ? "none" : undefined;
  const enabledBudget = zeroBudgetDisablesThinking ? undefined : budget;
  const think =
    override ??
    budgetEffort ??
    preferredEffort ??
    (modeBudget && configuredThink === "none" ? "medium" : configuredThink);
  const reasoningControlSource = resolveReasoningControlSource(
    override,
    applies,
    profile,
  );
  if (!preference && !configuredBudget && !modeBudget)
    return { think: profile.supportsThinking ? think : undefined };
  if (!profile.supportsThinking)
    return { think: undefined, reasoningControlSource };
  if (think === "none") return { think, reasoningControlSource };
  return {
    think,
    ...(enabledBudget ? { reasoningBudget: enabledBudget } : {}),
    reasoningControlSource,
  };
}

function resolveReasoningControlSource(
  override: ModelReasoningLevel | undefined,
  applies: boolean,
  profile: ModelProfile,
): "invocation" | "request" | "configuration" | "agent-mode" {
  if (override) return "invocation";
  if (applies) return "request";
  if (profile.generation.reasoningEffort !== undefined) return "configuration";
  if (profile.generation.reasoningBudget !== undefined) return "configuration";
  if (profile.generation.reasoningBudgetByMode !== undefined)
    return "configuration";
  return "agent-mode";
}

function resolvePreferredEffort(
  preference: ModelReasoningPreference | undefined,
  configuredThink: ModelReasoningLevel,
): ModelReasoningLevel | undefined {
  if (!preference) return undefined;
  if (preference.mode === "off") return "none";
  return configuredThink === "none" ? "medium" : configuredThink;
}
