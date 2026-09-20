export function malformedConfigRaw(file) {
  if (file?.kind !== "model" && file?.kind !== "requestRunner") return undefined;
  const raw = file.invalidJson?.raw;
  return typeof raw === "string" ? raw : undefined;
}

export function configRequiresRawRepair(file, appliedRepair = false) {
  if (appliedRepair) return false;
  return malformedConfigRaw(file) !== undefined;
}

export function configRepairGuidance(file) {
  if (malformedConfigRaw(file) === undefined) return "";
  return "This saved file contains invalid JSON. Correct the JSON, then save the file. Reset restores the original text; other configuration files are preserved.";
}

export function selectMalformedConfigForRepair(state, files, configFileKey) {
  const file = files.find((entry) => configRequiresRawRepair(entry));
  if (!file) return;
  state.selectedRawConfigKey = configFileKey(file);
  state.activeCategory = "advanced";
  state.rawPanelOpen = true;
}

export function configRepairSaveIsConfirmed(result) {
  if (!result?.file) return false;
  return !result.file.invalidJson;
}
