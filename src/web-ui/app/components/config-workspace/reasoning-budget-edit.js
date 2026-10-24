import {
  effectiveReasoningBudgetEffort,
  isTokenBudgetModel,
  reasoningBudgetStatusText,
} from "./reasoning-budget.js";

function isReasoningGenerationPath(path) {
  if (!Array.isArray(path)) return false;
  if (path.length === 1) return path[0] === "generation";
  if (path.length !== 3) return false;
  return path[0] === "calibration" && typeof path[1] === "string" &&
    path[2] === "generation";
}

function budgetEditGenerationPath(path) {
  const budgetIndex = path.lastIndexOf("reasoningBudget");
  if (budgetIndex < 0) return undefined;
  const generation = path.slice(0, budgetIndex);
  return isReasoningGenerationPath(generation) ? generation : undefined;
}

function reasoningStatusGenerationPath(element) {
  try {
    const path = JSON.parse(element.dataset.reasoningGenerationPath);
    return isReasoningGenerationPath(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function generationCalibration(file, path) {
  if (path[0] !== "calibration") return undefined;
  return file.config.calibration?.[path[1]];
}

function hasPositiveReasoningTokenLimit(value) {
  if (!Number.isInteger(value)) return false;
  if (value <= 0) return false;
  return value <= 2147483647;
}

function budgetModeEnablesThinking(value) {
  if (value?.mode === "server-default") return true;
  if (value?.mode !== "tokens") return false;
  return hasPositiveReasoningTokenLimit(value.tokens);
}

function explicitlyEnablesBudget(path, value) {
  if (path.at(-1) === "reasoningBudget")
    return budgetModeEnablesThinking(value);
  if (path.at(-1) !== "tokens" || path.at(-2) !== "reasoningBudget")
    return false;
  return hasPositiveReasoningTokenLimit(value);
}

/** A form budget action enables only the edited generation scope. */
export function activateEditedReasoningBudget(
  file,
  dashboard,
  path,
  value,
  setConfigPathValue,
) {
  if (file.kind !== "model" || !explicitlyEnablesBudget(path, value))
    return undefined;
  const generationPath = budgetEditGenerationPath(path);
  if (!generationPath) return undefined;
  const calibration = generationCalibration(file, generationPath);
  if (!isTokenBudgetModel(file, dashboard, calibration)) return undefined;
  const effort = effectiveReasoningBudgetEffort(
    file,
    dashboard,
    generationPath,
  );
  if (effort !== undefined && effort !== "none") return undefined;
  setConfigPathValue(
    file.config,
    [...generationPath, "reasoningEffort"],
    "medium",
  );
  return generationPath;
}

function matchesReasoningControl(element, file) {
  return element.dataset.kind === file.kind && element.dataset.id === file.id;
}

/** Numeric input keeps focus while the coupled select and status update. */
export function syncActivatedReasoningBudget(
  root,
  file,
  dashboard,
  generationPath,
) {
  const effortPath = JSON.stringify([...generationPath, "reasoningEffort"]);
  for (const element of root.querySelectorAll(
    'select[data-config-action="field"]',
  )) {
    if (!matchesReasoningControl(element, file)) continue;
    if (element.dataset.path !== effortPath) continue;
    element.value = "medium";
  }
  for (const element of root.querySelectorAll(
    "[data-reasoning-generation-path]",
  )) {
    if (!matchesReasoningControl(element, file)) continue;
    const statusPath = reasoningStatusGenerationPath(element);
    if (!statusPath) continue;
    const calibration = generationCalibration(file, statusPath);
    if (!isTokenBudgetModel(file, dashboard, calibration)) continue;
    element.textContent = reasoningBudgetStatusText(file, dashboard, statusPath);
  }
}
