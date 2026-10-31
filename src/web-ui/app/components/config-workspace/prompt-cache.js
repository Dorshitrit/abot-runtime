import { escapeAttribute } from "../../lib/text-format.js";

function isOpenAIModel(file, dashboard) {
  if (file.kind !== "model") return false;
  const provider = file.config?.provider;
  return dashboard?.files?.runtime?.config?.models?.providers?.[provider]?.type === "openai";
}

export function isImplicitPromptCacheOption(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 1) return false;
  return value.mode === "implicit";
}

export function parsePromptCacheInput(checked) {
  return checked ? { mode: "implicit" } : undefined;
}

export function renderModelPromptCache(file, dashboard) {
  if (!isOpenAIModel(file, dashboard)) return "";
  const checked = isImplicitPromptCacheOption(file.config?.options?.prompt_cache_options) ? "checked" : "";
  return '<label class="config-toggle"><input type="checkbox" data-config-action="field" data-kind="model" data-id="' + escapeAttribute(file.id) + '" data-path="' + escapeAttribute(JSON.stringify(["options", "prompt_cache_options"])) + '" data-value-type="prompt-cache" ' + checked + ' /><span>Optimize prompt caching</span><small>Applies only to Execution Agent decisions. Requires GPT-5.6+ or compatible OpenAI API support for explicit cache boundaries. Unchecked keeps provider defaults.</small></label>';
}

export function cleanupModelPromptCache(file, dashboard, path) {
  if (file.kind !== "model") return;
  const providerChanged = path.length === 1 && path[0] === "provider";
  const cacheChanged = path.length === 2 && path[0] === "options" && path[1] === "prompt_cache_options";
  if (!providerChanged && !cacheChanged) return;
  const options = file.config?.options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return;
  if (!isOpenAIModel(file, dashboard)) delete options.prompt_cache_options;
  if (Object.keys(options).length === 0) delete file.config.options;
}
