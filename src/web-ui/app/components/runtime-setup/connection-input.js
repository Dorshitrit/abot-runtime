import { readConnectionSecret, validateConnectionFields } from "./connection-form.js";

/** One connection submission, including private key read only at submission time. */
export function runtimeSetupConnectionInput(state, container, fieldError) {
  const result = validateConnectionFields({
    ...state, modelId: state.modelId, providerType: state.provider,
  });
  if (!result.valid) {
    fieldError(result.field, result.message);
    return null;
  }
  const input = { provider: state.provider, ...result.input };
  if (state.editableConnection?.revision)
    input.connectionRevision = state.editableConnection.revision;
  if (state.provider === "openai-chatgpt") {
    if (!state.accountRef || !state.chatgptAccountReady) {
      fieldError("account", "Connect a ChatGPT account with plan usage enabled.");
      return null;
    }
    return { ...input, accountRef: state.accountRef };
  }
  if (state.provider === "ollama") return input;
  const apiKey = readConnectionSecret(container);
  const provider = state.providers.find((entry) => entry.id === state.provider);
  if (provider?.requiresApiKey === true && provider?.credentialConfigured !== true && !apiKey) {
    fieldError("api-key", "Enter the API key for this connection.");
    return null;
  }
  return apiKey ? { ...input, apiKey } : input;
}
