import { validateConnectionFields } from "../runtime-setup/connection-form.js";

export function selectedModelProvider(state) {
  return (
    state.providers.find(
      (provider) => `existing:${provider.id}` === state.choice,
    ) || null
  );
}

export function modelProviderType(state) {
  return selectedModelProvider(state)?.type || state.choice.replace("new:", "");
}

export function suggestIdentifier(value, existing, fallback = "model") {
  const clean =
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 110) || fallback;
  const base = ["__proto__", "prototype", "constructor"].includes(clean)
    ? `${fallback}-${clean}`
    : clean;
  let candidate = base;
  let suffix = 2;
  while (existing.includes(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function validIdentifier(value, provider) {
  const pattern = provider
    ? /^[A-Za-z][A-Za-z0-9._-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  return (
    value.length <= 128 &&
    pattern.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value)
  );
}

export function validateModelDraft(state) {
  const provider = selectedModelProvider(state);
  if (!provider && !["new:openai", "new:ollama"].includes(state.choice))
    return { valid: false, field: "provider", message: "Choose a provider." };
  if (!provider && !validIdentifier(state.newProviderId, true))
    return {
      valid: false,
      field: "connection-id",
      message:
        "Start the connection ID with a letter and use up to 128 letters, numbers, dots, underscores or hyphens.",
    };
  if (
    !provider &&
    state.providers.some((entry) => entry.id === state.newProviderId)
  )
    return {
      valid: false,
      field: "connection-id",
      message:
        "That connection ID already exists. Choose another or use its existing provider.",
    };
  if (state.model.length > 256)
    return {
      valid: false,
      field: "model-id",
      message: "Use a model ID of up to 256 characters.",
    };
  const connection = validateConnectionFields({
    modelId: state.model,
    contextWindowTokens: state.contextWindowTokens,
    providerType: modelProviderType(state),
    baseUrl: state.baseUrl,
    existingProvider: Boolean(provider),
  });
  if (!connection.valid) return connection;
  if (!validIdentifier(state.profileId, false))
    return {
      valid: false,
      field: "profile-id",
      message:
        "Use up to 128 letters, numbers, dots, underscores or hyphens for the model profile ID.",
    };
  if (state.profileIds.includes(state.profileId))
    return {
      valid: false,
      field: "profile-id",
      message: "That model profile ID already exists. Choose another.",
    };
  return connection;
}

export function requiresModelCredential(state) {
  const provider = selectedModelProvider(state);
  const configured =
    provider?.credentialConfigured === true ||
    state.credentialSavedFor === (provider?.id || state.newProviderId);
  return modelProviderType(state) === "openai" && !configured;
}

export function requiresModelSaveCredential(state) {
  if (state.saveOutcomeUncertain) return false;
  return requiresModelCredential(state);
}

export function modelSetupInput(state, validated, apiKey) {
  const provider = selectedModelProvider(state);
  const connection = provider
    ? { providerId: provider.id }
    : {
        newProvider: {
          id: state.newProviderId,
          type: modelProviderType(state),
          ...(validated.input.baseUrl
            ? { baseUrl: validated.input.baseUrl }
            : {}),
        },
      };
  return {
    profileId: state.profileId,
    model: validated.input.model,
    contextWindowTokens: validated.input.contextWindowTokens,
    ...connection,
    ...(apiKey ? { apiKey } : {}),
  };
}
