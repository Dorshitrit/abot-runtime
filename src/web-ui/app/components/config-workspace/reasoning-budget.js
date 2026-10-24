import { escapeAttribute } from "../../lib/text-format.js";

function reasoningBudgetTarget(file, dashboard, calibration) {
  const targetId = calibration?.profileId;
  return targetId && targetId !== file.id
    ? dashboard?.files?.models?.find((model) => model.id === targetId)
    : file;
}

export function isTokenBudgetModel(file, dashboard, calibration) {
  const target = reasoningBudgetTarget(file, dashboard, calibration);
  if (target?.config?.supportsThinking !== true) return false;
  const providerId = target.config.provider;
  return dashboard?.files?.runtime?.config?.models?.providers?.[providerId]?.type === "llamacpp";
}

export function shouldRefreshReasoningBudgetFields(file, path, valueType) {
  if (valueType === "reasoning-budget-mode") return true;
  if (valueType === "reasoning-mode-budgets") return true;
  if (file.kind !== "model") return false;
  if (path.at(-1) === "reasoningEffort") return true;
  if (path.length !== 1) return false;
  return path[0] === "supportsThinking" || path[0] === "provider";
}

export function parseReasoningBudgetMode(value, previous) {
  if (value === "inherit") return undefined;
  if (value === "server-default") return { mode: "server-default" };
  return { mode: "tokens", tokens: previous?.mode === "tokens" ? previous.tokens : 0 };
}

export function effectiveReasoningBudgetEffort(file, dashboard, generationPath) {
  const generation = generationPath.reduce((value, key) => value?.[key], file.config);
  if (generation?.reasoningEffort !== undefined) return generation.reasoningEffort;
  if (generationPath[0] !== "calibration") return undefined;
  const calibration = file.config?.calibration?.[generationPath[1]];
  return reasoningBudgetTarget(file, dashboard, calibration)?.config?.generation?.reasoningEffort;
}

export function reasoningBudgetStatusText(file, dashboard, generationPath) {
  const budget = generationPath.reduce((value, key) => value?.[key], file.config)?.reasoningBudget;
  const savedBudgetIsOff = budget !== undefined &&
    effectiveReasoningBudgetEffort(file, dashboard, generationPath) === "none";
  if (savedBudgetIsOff)
    return "Inactive while reasoning is Off. Choose a positive token limit or Server default to enable thinking.";
  return "Per reasoning segment. Zero disables thinking; a positive budget enables it. Off keeps the saved budget inactive.";
}

export function renderReasoningEffort(file, generationPath, renderConfigInput) {
  return `<label><span>Reasoning effort</span>${renderConfigInput(file, [...generationPath, "reasoningEffort"], {
    type: "select", values: ["", "none", "minimal", "low", "medium", "high", "xhigh"],
  })}<small>Default inherits the profile or request mode. None disables thinking unless a mode token limit or request setting enables it.</small></label>`;
}

export function renderReasoningBudget(file, generationPath, renderConfigInput, { supported = true, dashboard } = {}) {
  const budget = generationPath.reduce((value, key) => value?.[key], file.config)?.reasoningBudget;
  if (!supported && budget === undefined) return "";
  const path = [...generationPath, "reasoningBudget"];
  const mode = budget?.mode || "inherit";
  const attributes = `data-config-action="field" data-kind="${escapeAttribute(file.kind)}" data-id="${escapeAttribute(file.id)}" data-path="${escapeAttribute(JSON.stringify(path))}" data-value-type="reasoning-budget-mode"`;
  return `<label><span>Thinking budget</span><select ${attributes}>
    <option value="inherit" ${mode === "inherit" ? "selected" : ""}>Inherit (no override)</option>
    ${supported ? `<option value="server-default" ${mode === "server-default" ? "selected" : ""}>Server default</option>
    <option value="tokens" ${mode === "tokens" ? "selected" : ""}>Token limit</option>` : `<option value="${escapeAttribute(mode)}" selected disabled>Saved override (unsupported target)</option>`}
  </select><small data-reasoning-generation-path="${escapeAttribute(JSON.stringify(generationPath))}" data-kind="${escapeAttribute(file.kind)}" data-id="${escapeAttribute(file.id)}">${supported ? reasoningBudgetStatusText(file, dashboard, generationPath) : "This target does not support token budgets. Choose Inherit to remove this override."}</small></label>
  ${supported && mode === "tokens" ? `<label><span>Thinking tokens</span>${renderConfigInput(file, [...path, "tokens"], { type: "number", min: "0", step: "1" })}<small>Enter a non-negative whole number; 0 disables thinking. The answer also needs capacity within the total output limit.</small></label>` : ""}`;
}
