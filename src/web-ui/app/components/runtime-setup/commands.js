import {
  DEFAULT_OLLAMA_BASE_URL,
  normalizeProvider,
  validateRuntimeSetupBaseUrl,
  validateRuntimeSetupModelId,
} from "./validation.js";

export function buildRuntimeSetupCommands(
  provider,
  modelId,
  ollamaBaseUrl = DEFAULT_OLLAMA_BASE_URL,
  setupCommandMode = "source",
) {
  const selectedProvider = normalizeProvider(provider);
  const validation = validateRuntimeSetupModelId(modelId);
  const baseUrlValidation = validateRuntimeSetupBaseUrl(ollamaBaseUrl);
  const providerArgument = selectedProvider || "<provider>";
  const modelArgument = validation.valid ? validation.value : "<model-id>";
  const baseUrlArgument = baseUrlValidation.valid
    ? baseUrlValidation.value
    : "<ollama-base-url>";
  const packaged = setupCommandMode === "package";
  const initPrefix = packaged ? "npx abot init" : "npm run init --";
  const init = `${initPrefix} --provider ${providerArgument} --model ${modelArgument}${
    selectedProvider === "ollama" ? ` --base-url ${baseUrlArgument}` : ""
  }`;
  return {
    "ollama-pull": `ollama pull ${modelArgument}`,
    setup: init,
    "model-gateway": packaged ? "npx abot start" : "npm run model-gateway",
    "web-ui": packaged ? "" : "npm run web-ui",
  };
}

// Bridge launch settings are private server state, not browser configuration.
export function buildBridgeSetupCommands(
  provider,
  modelId,
  ollamaBaseUrl,
  setupCommandMode,
) {
  const commands = buildRuntimeSetupCommands(
    provider,
    modelId,
    ollamaBaseUrl,
    setupCommandMode,
  );
  const packaged = setupCommandMode === "package";
  return {
    ...commands,
    "model-gateway": packaged ? "" : commands["model-gateway"],
    "web-ui": "",
  };
}
