import { parseBaseUrl } from "../../../scripts/runtime-setup-files.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

export type SetupEmbeddingInput = Readonly<{
  providerId?: string;
  provider?: "openai" | "ollama" | "llamacpp";
  newProviderId?: string;
  useApiKey?: boolean;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}>;

function optionalInputString(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeSetupError(
      "invalid_embedding_input",
      `The ${name} field must be a non-empty string.`,
    );
  }
  return value.trim();
}

function hasOneProviderSelection(
  providerId?: string,
  provider?: string,
): boolean {
  if (providerId) return provider === undefined;
  return provider !== undefined;
}

function isSupportedProvider(
  provider: string,
): provider is "openai" | "ollama" | "llamacpp" {
  return (
    provider === "openai" || provider === "ollama" || provider === "llamacpp"
  );
}

function isUsableModelIdentifier(model: string | undefined): model is string {
  if (!model || model.length > 256) return false;
  return !/[\u0000-\u0020\u007f]/u.test(model);
}

function isSafeCredential(apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  if (apiKey.length > 4096) return false;
  return !/[\u0000-\u0020\u007f'"`]/u.test(apiKey);
}

export function parseSetupEmbeddingInput(
  body: Record<string, unknown>,
): SetupEmbeddingInput {
  const allowed = [
    "providerId",
    "provider",
    "model",
    "baseUrl",
    "apiKey",
    "newProviderId",
    "useApiKey",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new RuntimeSetupError(
      "invalid_embedding_input",
      "The embedding update contains unsupported fields.",
    );
  }
  const providerId = optionalInputString(body, "providerId");
  const provider = optionalInputString(body, "provider");
  if (!hasOneProviderSelection(providerId, provider)) {
    throw new RuntimeSetupError(
      "invalid_embedding_provider",
      "Choose one configured provider or one provider type.",
    );
  }
  if (provider && !isSupportedProvider(provider)) {
    throw new RuntimeSetupError(
      "invalid_embedding_provider",
      "Choose OpenAI, Ollama or llama.cpp when adding a provider.",
    );
  }
  const newConnection = parseNewLlamaEmbeddingConnection(body, provider);
  const model = optionalInputString(body, "model");
  if (!isUsableModelIdentifier(model)) {
    throw new RuntimeSetupError(
      "invalid_embedding_model",
      "Enter a model ID without spaces or control characters.",
    );
  }
  const apiKey = optionalInputString(body, "apiKey");
  if (!isSafeCredential(apiKey)) {
    throw new RuntimeSetupError(
      "invalid_embedding_credential",
      "The API key contains unsupported characters.",
    );
  }
  const address = optionalInputString(body, "baseUrl");
  if (address && provider !== "ollama" && provider !== "llamacpp") {
    throw new RuntimeSetupError(
      "invalid_embedding_address",
      "An address can be supplied when adding an Ollama or llama.cpp provider.",
    );
  }
  let baseUrl: string | undefined;
  try {
    baseUrl = address ? parseBaseUrl(address) : undefined;
  } catch {
    throw new RuntimeSetupError(
      "invalid_embedding_address",
      "Enter an HTTP or HTTPS origin without a path or credentials.",
    );
  }
  return {
    ...(providerId ? { providerId } : {}),
    ...(provider
      ? { provider: provider as "openai" | "ollama" | "llamacpp" }
      : {}),
    ...newConnection,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function parseNewLlamaEmbeddingConnection(
  body: Record<string, unknown>,
  provider?: string,
) {
  const newProviderId = optionalInputString(body, "newProviderId");
  const useApiKey = body.useApiKey;
  const hasConnectionIntent =
    newProviderId !== undefined || useApiKey !== undefined;
  if (provider !== "llamacpp" && hasConnectionIntent)
    throw new RuntimeSetupError(
      "invalid_embedding_input",
      "New connection identity and authentication apply only to a new llama.cpp connection.",
    );
  if (provider !== "llamacpp") return {};
  const hasValidNewProviderId =
    typeof newProviderId === "string" &&
    newProviderId.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._-]*$/u.test(newProviderId) &&
    !["__proto__", "prototype", "constructor"].includes(newProviderId);
  if (!hasValidNewProviderId)
    throw new RuntimeSetupError(
      "invalid_embedding_provider",
      "Enter a connection ID starting with a letter and containing only letters, numbers, dots, underscores or hyphens.",
    );
  if (useApiKey !== undefined && typeof useApiKey !== "boolean")
    throw new RuntimeSetupError(
      "invalid_embedding_input",
      "The API key choice must be true or false.",
    );
  if (useApiKey === false && body.apiKey !== undefined)
    throw new RuntimeSetupError(
      "invalid_embedding_credential",
      "The API key conflicts with the no-authentication choice.",
    );
  return { newProviderId, ...(useApiKey !== undefined ? { useApiKey } : {}) };
}
