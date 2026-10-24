import { escapeAttribute } from "../../lib/text-format.js";

export function setupReasoningState(model = {}) {
  return {
    supportsThinking: model.supportsThinking,
    reasoningBudgetMode: model.reasoningBudget?.mode || "inherit",
    reasoningBudgetTokens: model.reasoningBudget?.tokens?.toString() || "",
  };
}

export function updateSetupReasoningField(state, field, value) {
  if (field === "supports-thinking") state.supportsThinking = value === true;
  if (field === "reasoning-budget-mode") state.reasoningBudgetMode = value;
  if (field === "reasoning-budget-tokens") state.reasoningBudgetTokens = value;
  return ["supports-thinking", "reasoning-budget-mode"].includes(field);
}

export function renderSetupReasoningFields(state, readonly = false) {
  const hasTokenBudget = (state.providerType || state.provider) === "llamacpp";
  const disabled = readonly ? "disabled" : "";
  const mode = state.reasoningBudgetMode || "inherit";
  const supportsThinking = state.supportsThinking === true;
  return `<label class="runtime-setup-field runtime-setup-reasoning-toggle"><span class="runtime-setup-reasoning-toggle-label"><input type="checkbox" data-runtime-setup-field="supports-thinking" ${supportsThinking ? "checked" : ""} ${disabled} /> This model supports thinking</span><small>Enable only for a model and chat template that support reasoning. Connection readiness does not verify this.</small></label>
    ${supportsThinking && hasTokenBudget ? `<label class="runtime-setup-field"><span>Default thinking budget</span><select data-runtime-setup-field="reasoning-budget-mode" ${disabled}>
      <option value="inherit" ${mode === "inherit" ? "selected" : ""}>Inherit (no override)</option>
      <option value="server-default" ${mode === "server-default" ? "selected" : ""}>Server default</option>
      <option value="tokens" ${mode === "tokens" ? "selected" : ""}>Token limit</option>
    </select><small>Applies to each reasoning segment. It is not a time limit or a total request budget.</small></label>
    ${mode === "tokens" ? `<label class="runtime-setup-field"><span>Thinking tokens</span><input type="number" min="0" max="2147483647" step="1" data-runtime-setup-field="reasoning-budget-tokens" value="${escapeAttribute(state.reasoningBudgetTokens ?? "")}" ${disabled} required /><small>Zero disables thinking. The server forces the reasoning segment to close at a positive limit; the answer still needs output capacity.</small></label>` : ""}` : ""}`;
}

function isSetupReasoningTokenBudget(state, mode, tokens) {
  if (mode !== "tokens") return false;
  if (String(state.reasoningBudgetTokens ?? "").trim() === "") return false;
  if (!Number.isSafeInteger(tokens)) return false;
  if (tokens < 0) return false;
  return tokens <= 2147483647;
}

export function validateSetupReasoningFields(state) {
  if (state.providerType !== "llamacpp")
    return { valid: true, input: state.supportsThinking === undefined ? {} : { supportsThinking: state.supportsThinking === true } };
  const supportsThinking = state.supportsThinking === true;
  const input = { supportsThinking };
  if (!supportsThinking) return { valid: true, input };
  const mode = state.reasoningBudgetMode || "inherit";
  if (mode === "inherit") return { valid: true, input };
  if (mode === "server-default")
    return { valid: true, input: { ...input, reasoningBudget: { mode } } };
  const tokens = Number(state.reasoningBudgetTokens);
  if (!isSetupReasoningTokenBudget(state, mode, tokens))
    return { valid: false, field: "reasoning-budget-tokens", message: "Enter a whole number of thinking tokens from 0 to 2147483647; 0 disables thinking." };
  return { valid: true, input: { ...input, reasoningBudget: { mode, tokens } } };
}
