import { escapeAttribute } from "../../lib/text-format.js";

const REASONING_MODES = [["fast", "Low"], ["reasoning", "Reasoning"], ["deep", "Deep"]];

export function parseReasoningModeBudgets(value, previous) {
  if (value === "inherit") return undefined;
  return previous ?? {};
}

export function renderReasoningModeBudgets(file, generationPath, renderConfigInput, { supported = true } = {}) {
  const generation = generationPath.reduce((value, key) => value?.[key], file.config);
  const budgets = generation?.reasoningBudgetByMode;
  if (!supported && budgets === undefined) return "";
  const path = [...generationPath, "reasoningBudgetByMode"];
  const custom = budgets !== undefined;
  const attributes = `data-config-action="field" data-kind="${escapeAttribute(file.kind)}" data-id="${escapeAttribute(file.id)}" data-path="${escapeAttribute(JSON.stringify(path))}" data-value-type="reasoning-mode-budgets"`;
  const selector = `<label><span>Mode token overrides</span><select ${attributes}>
    <option value="inherit" ${custom ? "" : "selected"}>Inherit (no override)</option>
    ${supported ? `<option value="custom" ${custom ? "selected" : ""}>Custom limits by mode</option>` : '<option value="custom" selected disabled>Saved override (unsupported target)</option>'}
  </select><small>${supported
    ? "Optional limits for main model steps. A custom map replaces inherited mode limits; blank entries use the ordinary effort and budget settings."
    : "This target does not support token budgets. Choose Inherit to remove this override."}</small></label>`;
  if (!supported || !custom) return selector;
  return selector + REASONING_MODES.map(([mode, label]) => `<label><span>${label} thinking tokens</span>${renderConfigInput(file, [...path, mode], { type: "number", min: "0", step: "1" })}<small>Optional non-negative integer. Zero disables thinking; positive values enable it for this mode, including Low. Explicit request or invocation Off still wins.</small></label>`).join("");
}
