import { parseRuntimeModelProfileId } from "../../../scripts/runtime-model-addition.js";
import {
  parseBaseUrl,
  parseContextWindowTokens,
} from "../../../scripts/runtime-setup-files.js";
import { isRecord } from "../../runtime/config/utils.js";

export type NewModelProvider = Readonly<{
  id: string;
  type: "openai" | "ollama";
  baseUrl?: string;
}>;
export type ModelSetupInput = Readonly<{
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

function readNewProvider(value: unknown): NewModelProvider {
  if (!isRecord(value))
    throw new ModelSetupError(
      "invalid_model_provider",
      "Choose a configured provider or add a new provider.",
    );
  requireAllowedFields(value, ["id", "type", "baseUrl"]);
  const id = requireIdentifier(inputString(value, "id")!, "provider");
  const type = inputString(value, "type");
  if (type !== "openai" && type !== "ollama")
    throw new ModelSetupError(
      "invalid_model_provider",
      "A new provider must use OpenAI or Ollama.",
    );
  const address = inputString(value, "baseUrl", true);
  if (address && type !== "ollama")
    throw new ModelSetupError(
      "invalid_model_address",
      "A custom address is available for a new Ollama provider.",
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
  return { id, type, ...(baseUrl ? { baseUrl } : {}) };
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
    "providerId",
    "newProvider",
    "apiKey",
  ]);
  const profileId = requireIdentifier(
    inputString(body, "profileId")!,
    "profile",
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
    profileId,
    model,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...selection,
  };
}
