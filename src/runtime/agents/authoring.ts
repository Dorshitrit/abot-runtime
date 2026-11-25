import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type { AgentMissionLimits, AgentOnboarding, AgentRecord } from "./agent-records.js";
import { agentBudgetPresets } from "./authoring-budgets.js";
import { buildAgentBasePrompt } from "./authoring-prompt.js";
import type { AgentDefinitionInput } from "./management-contracts.js";
import { readAgentMissionLimits, readAgentOnboarding } from "./record-validation.js";

type DraftChoices = Omit<AgentOnboarding, "role" | "budget"> & { role: AgentOnboarding["role"] | ""; budget: AgentOnboarding["budget"] | "" };
export type AgentAuthoringInput = {
  name: string; icon: string; modelProfileId: string; toolPermissionMode: ToolPermissionMode;
  onboarding: DraftChoices; limits?: AgentMissionLimits;
};
export type AgentAuthoringPreview = { basePrompt: string; presets: ReturnType<typeof agentBudgetPresets>; limits: AgentMissionLimits | null };
const initialChoices: DraftChoices = {
  role: "", outputs: [], style: "balanced", asks: ["unclear", "tradeoffs"], updates: "needed",
  custom: "", notes: "", color: "blue", budget: "",
};

function fields(value: unknown, allowed: readonly string[], partial: boolean): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agents_input_authoring");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error("agents_input_authoring_fields");
  if (!partial && allowed.some(key => key !== "limits" && !Object.hasOwn(record, key))) throw new Error("agents_input_authoring_fields");
  return record;
}
function textField(value: unknown, maximum: number, partial: boolean): string {
  if (partial && value === undefined) return "";
  if (typeof value !== "string" || value.length > maximum || (!partial && !value.trim())) throw new Error("agents_input_authoring_text");
  return value;
}
function readCustomBudget(value: unknown): AgentMissionLimits {
  const limits = readAgentMissionLimits(value);
  if (limits.maxAttempts === 0 || limits.maxModelCalls === 0 || limits.maxTotalTokens === 0) throw new Error("agents_input_authoring_limits");
  return limits;
}
export function readAgentAuthoring(value: unknown, partial = false): AgentAuthoringInput {
  const input = fields(value, ["name", "icon", "modelProfileId", "toolPermissionMode", "onboarding", "limits"], partial);
  const raw = fields(input.onboarding === undefined && partial ? {} : input.onboarding, Object.keys(initialChoices), partial);
  const choices = { ...initialChoices, ...raw };
  const check = { ...choices, role: choices.role === "" && partial ? "custom" : choices.role, budget: choices.budget === "" && partial ? "custom" : choices.budget };
  readAgentOnboarding(check);
  if (!partial && !choices.outputs.length) throw new Error("agents_input_authoring_outputs");
  if (!partial && choices.role === "custom" && !choices.custom.trim()) throw new Error("agents_input_authoring_focus");
  const mode = partial && input.toolPermissionMode === undefined ? "ask" : input.toolPermissionMode;
  if (mode !== "ask" && mode !== "full_access" && mode !== "full_plus") throw new Error("agents_input_permission");
  if (Object.hasOwn(input, "limits") && choices.budget !== "custom") throw new Error("agents_input_authoring_limits");
  const limits = Object.hasOwn(input, "limits") ? readCustomBudget(input.limits) : undefined;
  if (!partial && choices.budget === "custom" && !limits) throw new Error("agents_input_authoring_limits");
  return {
    name: textField(input.name, 80, partial), icon: textField(input.icon, 80, partial),
    modelProfileId: textField(input.modelProfileId, 256, partial), toolPermissionMode: mode,
    onboarding: choices, ...(limits ? { limits } : {}),
  };
}
export function readAgentAuthoringMutation(body: Record<string, unknown>): { authoring: AgentAuthoringInput } {
  if (["definition", "limits", "onboarding"].some(key => Object.hasOwn(body, key))) throw new Error("agents_input_authoring_fields");
  return { authoring: readAgentAuthoring(body.authoring) };
}
type ResolvePolicy = (profileId: string) => RequestExecutionPolicyId;
export function previewAgentAuthoring(input: AgentAuthoringInput, resolvePolicy: ResolvePolicy, current?: AgentRecord): AgentAuthoringPreview {
  const choices = input.onboarding;
  const profileId = input.modelProfileId || current?.definition.modelProfileId;
  const policy = profileId ? resolvePolicy(profileId) : undefined;
  const presets = agentBudgetPresets(choices.role || current?.definition.onboarding?.role, policy);
  const basePrompt = choices.role === "custom" && !choices.notes && choices.custom === current?.definition.basePrompt
    ? current.definition.basePrompt : buildAgentBasePrompt(input.name, { ...choices, role: choices.role || "custom", budget: choices.budget || "custom" });
  if (basePrompt.length > 16_000) throw new Error("agents_input_base_prompt");
  const limits = choices.budget === "custom" ? input.limits ?? null : choices.budget ? presets[choices.budget] : null;
  return { basePrompt, presets, limits };
}
export function materializeAgentAuthoring(input: AgentAuthoringInput, resolvePolicy: ResolvePolicy, current?: AgentRecord): AgentDefinitionInput {
  const draft = readAgentAuthoring(input);
  const { basePrompt, limits } = previewAgentAuthoring(draft, resolvePolicy, current);
  if (!limits || !draft.onboarding.role || !draft.onboarding.budget) throw new Error("agents_input_authoring");
  return {
    name: draft.name.trim(), icon: current?.id === "abot" ? current.definition.icon : draft.icon,
    basePrompt, modelProfileId: draft.modelProfileId, toolPermissionMode: draft.toolPermissionMode, defaultLimits: limits,
    onboarding: { ...draft.onboarding, role: draft.onboarding.role, budget: draft.onboarding.budget },
  };
}
