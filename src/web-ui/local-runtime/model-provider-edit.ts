import { parseBaseUrl } from "../../../scripts/runtime-setup-files.js";
import {
  parseProviderCredentialEnvironment,
  supportsProviderAddress,
  supportsProviderCredential,
} from "../../../scripts/runtime-setup-provider-options.js";
import { requireChatGptAccountRef } from "../../provider-auth/chatgpt/contracts.js";
import { isRecord } from "../../runtime/config/utils.js";
import { requireConnectedChatGptSetupAccount } from "./chatgpt-setup-binding.js";
import { ModelSetupError } from "./model-setup-input.js";

function editableConnectionFields(type: string): string[] {
  const fields: string[] = [];
  if (supportsProviderAddress(type)) fields.push("baseUrl");
  if (supportsProviderCredential(type)) fields.push("apiKeyEnv");
  if (type === "ollama") fields.push("keepAlive");
  if (type === "openai-chatgpt") fields.push("accountRef");
  return fields;
}

function connectionOrigin(value: string): string {
  try {
    return parseBaseUrl(value);
  } catch {
    throw new ModelSetupError(
      "invalid_model_address",
      "Enter an HTTP or HTTPS origin without a path or credentials.",
    );
  }
}

function credentialEnvironment(value: string): string | undefined {
  try {
    return parseProviderCredentialEnvironment(value || undefined);
  } catch {
    throw new ModelSetupError(
      "invalid_model_credential",
      "Enter a valid environment variable name.",
    );
  }
}

function setOptionalConnectionField(
  provider: Record<string, unknown>,
  key: "keepAlive" | "apiKeyEnv",
  value: string | undefined,
) {
  if (!value) {
    delete provider[key];
    return;
  }
  provider[key] = value;
}

async function bindConnectedAccount(
  provider: Record<string, unknown>,
  value: string,
) {
  let accountRef: string;
  try {
    accountRef = requireChatGptAccountRef(value);
  } catch {
    throw new ModelSetupError(
      "invalid_model_account",
      "Choose a saved ChatGPT account.",
    );
  }
  const settings = isRecord(provider.settings) ? provider.settings : {};
  provider.settings = { ...settings, accountRef };
  try {
    await requireConnectedChatGptSetupAccount({
      ...provider,
      type: "openai-chatgpt",
    });
  } catch {
    throw new ModelSetupError(
      "model_account_unavailable",
      "Choose a connected ChatGPT account with plan usage enabled.",
      409,
    );
  }
}

function parseEditableFields(type: string, fields: Record<string, unknown>) {
  const allowed = editableConnectionFields(type);
  const entries = Object.entries(fields);
  const hasEditableSettings =
    entries.length > 0 && entries.every(([key]) => allowed.includes(key));
  if (!hasEditableSettings)
    throw new ModelSetupError(
      "invalid_model_provider_update",
      "Choose supported settings for this provider connection.",
    );
  const parsed: Record<string, string | undefined> = {};
  for (const [key, rawValue] of entries) {
    if (typeof rawValue !== "string")
      throw new ModelSetupError(
        "invalid_model_provider_update",
        "Connection settings must be strings.",
      );
    parsed[key] = rawValue.trim();
  }
  return parsed;
}

/** Patch submitted settings while preserving the rest of the saved adapter configuration. */
export async function editSavedModelProvider(
  saved: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  const { baseUrl, apiKeyEnv, keepAlive, accountRef } = parseEditableFields(
    String(saved.type).trim(),
    fields,
  );
  const provider = { ...saved };
  if (baseUrl !== undefined) provider.baseUrl = connectionOrigin(baseUrl);
  if (apiKeyEnv !== undefined)
    setOptionalConnectionField(
      provider,
      "apiKeyEnv",
      credentialEnvironment(apiKeyEnv),
    );
  if (keepAlive !== undefined)
    setOptionalConnectionField(provider, "keepAlive", keepAlive);
  if (accountRef !== undefined)
    await bindConnectedAccount(provider, accountRef);
  return provider;
}
