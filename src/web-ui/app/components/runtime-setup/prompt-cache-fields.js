export function setupPromptCacheState(model = {}) {
  return { promptCache: model.promptCache };
}

export function updateSetupPromptCacheField(state, field, value) {
  if (field !== "prompt-cache") return false;
  state.promptCache = value === true;
  return true;
}

export function setupPromptCacheInput(provider, enabled) {
  if (provider !== "openai") return {};
  if (enabled === undefined) return {};
  return { promptCache: enabled === true };
}

export function renderSetupPromptCacheField(state, readonly = false) {
  if ((state.providerType || state.provider) !== "openai") return "";
  const checked = state.promptCache === true ? "checked" : "";
  const disabled = readonly ? "disabled" : "";
  return '<label class="runtime-setup-field runtime-setup-reasoning-toggle"><span class="runtime-setup-reasoning-toggle-label"><input type="checkbox" data-runtime-setup-field="prompt-cache" ' + checked + ' ' + disabled + ' /> Optimize prompt caching</span><small>Applies only to Execution Agent decisions. Requires GPT-5.6+ or compatible OpenAI API support for explicit cache boundaries. Unchecked keeps provider defaults.</small></label>';
}
