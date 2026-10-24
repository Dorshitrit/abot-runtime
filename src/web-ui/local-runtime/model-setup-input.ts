import { parseRuntimeModelProfileId } from "../../../scripts/runtime-model-addition.js";
import {
  parseBaseUrl,
  parseContextWindowTokens,
} from "../../../scripts/runtime-setup-files.js";
import { parseSetupModelOptions, type SetupModelOptions } from "../../../scripts/runtime-setup-model-options.js";
import { supportsProviderAddress, parseProviderCredentialEnvironment } from "../../../scripts/runtime-setup-provider-options.js";
import { isRecord } from "../../runtime/config/utils.js";

export type NewModelProvider = Readonly<{
  id: string;
  type: "openai" | "ollama" | "llamacpp";
  apiKeyEnv?: string;
  useApiKey?: boolean;
  baseUrl?: string;
}>;
export type ModelSetupInput = SetupModelOptions & Readonly<{
  profileId: string;
  model: string;
  contextWindowTokens?: number;
  apiKey?: string;
}> &
  (
    | Readonly<{ providerId: string; newProvider?: never }>
    | Readonly<{ newProvider: NewModelProvider; providerId?: never }>
  );

export class ModelSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly credentialSaved = false,
  ) {
    super(message);
  }
}

function requireAllowedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ModelSetupError(
      "invalid_model_input",
      "The model update contains unsupported fields.",
    );
  }
}

function inputString(
  body: Record<string, unknown>,
  field: string,
  optional = false,
): string | undefined {
  const value = body[field];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new ModelSetupError(
      "invalid_model_input",
      `The ${field} field must be a non-empty string.`,
    );
  return value.trim();
}

function isReservedIdentifier(value: string): boolean {
  return ["__proto__", "prototype", "constructor"].includes(value);
}

function requireIdentifier(
  value: string,
  kind: "profile" | "provider",
): string {
  const pattern =
    kind === "provider"
      ? /^[A-Za-z][A-Za-z0-9._-]*$/u
      : /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
  if (
    value.length > 128 ||
    !pattern.test(value) ||
    isReservedIdentifier(value)
  ) {
    throw new ModelSetupError(
      `invalid_${kind}_id`,
      `Choose a ${kind} ID of up to 128 letters, numbers, dots, underscores, or dashes, starting with ${kind === "provider" ? "a letter" : "a letter or number"}.`,
    );
  }
  return kind === "profile" ? parseRuntimeModelProfileId(value) : value;
}

function hasWindowsDeviceBasename(value: string): boolean {
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
}

function requirePortableModelProfileId(value: string): string {
  const profileId = requireIdentifier(value, "profile");
  if (hasWindowsDeviceBasename(profileId))
    throw new ModelSetupError(
      "invalid_profile_id",
      "Choose a profile ID that is not a reserved Windows device name.",
    );
  return profileId;
}

function readNewProvider(value: unknown): NewModelProvider {
  if (!isRecord(value))
    throw new ModelSetupError(
      "invalid_model_provider",
      "Choose a configured provider or add a new provider.",
    );
  requireAllowedFields(value, ["id", "type", "baseUrl", "apiKeyEnv", "useApiKey"]);
  const id = requireIdentifier(inputString(value, "id")!, "provider");
  const type = inputString(value, "type");
  if (type !== "openai" && type !== "ollama" && type !== "llamacpp")
    throw new ModelSetupError(
      "invalid_model_provider",
      "A new provider must use OpenAI, Ollama or llama.cpp.",
    );
  const address = inputString(value, "baseUrl", true);
  if (address && !supportsProviderAddress(type))
    throw new ModelSetupError(
      "invalid_model_address",
      "A custom address is available for a new Ollama or llama.cpp provider.",
    );
  let baseUrl: string | undefined;
  try {
    baseUrl = address ? parseBaseUrl(address) : undefined;
  } catch {
    throw new ModelSetupError(
      "invalid_model_address",
      "Enter an HTTP or HTTPS origin without a path or credentials.",
    );
  }
  if (value.useApiKey !== undefined && (type !== "llamacpp" || typeof value.useApiKey !== "boolean"))
    throw new ModelSetupError("invalid_model_credential", "An optional API key choice is available for llama.cpp.");
  let apiKeyEnv: string | undefined;
  try {
    apiKeyEnv = parseProviderCredentialEnvironment(value.apiKeyEnv);
  } catch (error) {
    throw new ModelSetupError("invalid_model_credential", (error as Error).message);
  }
  if (apiKeyEnv && type !== "llamacpp")
    throw new ModelSetupError("invalid_model_credential", "A custom key environment is available for llama.cpp.");
  return { id, type, ...(baseUrl ? { baseUrl } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(value.useApiKey !== undefined ? { useApiKey: value.useApiKey as boolean } : {}) };
}

function requireModelIdentifier(model: string): void {
  if (model.length > 256 || /[\u0000-\u0020\u007f]/u.test(model))
    throw new ModelSetupError(
      "invalid_model_id",
      "Enter a model ID without spaces or control characters.",
    );
}

function requireSafeCredential(apiKey: string | undefined): void {
  if (!apiKey) return;
  if (apiKey.length > 4096 || /[\u0000-\u0020\u007f'"`]/u.test(apiKey))
    throw new ModelSetupError(
      "invalid_model_credential",
      "The API key contains unsupported characters.",
    );
}

export function parseModelSetupInput(
  body: Record<string, unknown>,
): ModelSetupInput {
  requireAllowedFields(body, [
    "profileId",
    "model",
    "contextWindowTokens",
    "supportsThinking",
    "reasoningBudget",
    "providerId",
    "newProvider",
    "apiKey",
  ]);
  let modelOptions: SetupModelOptions;
  try { modelOptions = parseSetupModelOptions(body); } catch (error) {
    throw new ModelSetupError("invalid_model_reasoning", (error as Error).message);
  }
  const profileId = requirePortableModelProfileId(
    inputString(body, "profileId")!,
  );
  let contextWindowTokens: number | undefined;
  try {
    contextWindowTokens = parseContextWindowTokens(body.contextWindowTokens);
  } catch {
    throw new ModelSetupError(
      "invalid_context_window",
      "Context window must be a positive whole number of tokens.",
    );
  }
  const model = inputString(body, "model")!;
  requireModelIdentifier(model);
  const apiKey = inputString(body, "apiKey", true);
  requireSafeCredential(apiKey);
  const providerId = inputString(body, "providerId", true);
  const hasOneProvider =
    (providerId !== undefined) !== (body.newProvider !== undefined);
  if (!hasOneProvider)
    throw new ModelSetupError(
      "invalid_model_provider",
      "Choose exactly one configured provider or new provider.",
    );
  const selection = providerId
    ? { providerId }
    : { newProvider: readNewProvider(body.newProvider) };
  return {
    ...modelOptions,
    profileId,
    model,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...selection,
  };
}
