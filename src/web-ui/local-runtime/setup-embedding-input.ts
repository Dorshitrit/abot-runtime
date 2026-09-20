import { parseBaseUrl } from "../../../scripts/runtime-setup-files.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

export type SetupEmbeddingInput = Readonly<{
  providerId?: string;
  provider?: "openai" | "ollama";
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
): provider is "openai" | "ollama" {
  return provider === "openai" || provider === "ollama";
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
  const allowed = ["providerId", "provider", "model", "baseUrl", "apiKey"];
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
      "Choose OpenAI or Ollama when adding a provider.",
    );
  }
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
  if (address && provider !== "ollama") {
    throw new RuntimeSetupError(
      "invalid_embedding_address",
      "An address can be supplied when adding an Ollama provider.",
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
    ...(provider ? { provider: provider as "openai" | "ollama" } : {}),
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}
