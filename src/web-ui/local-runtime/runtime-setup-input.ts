import { isWebSetupProvider, type WebSetupProvider } from "./setup-provider-choice.js";
import { readSetupChatGptAccountRef } from "./chatgpt-setup-binding.js";
import {
  parseBaseUrl,
  parseContextWindowTokens,
} from "../../../scripts/runtime-setup-files.js";

import { requireSetupPromptCacheProvider } from "../../../scripts/runtime-setup-prompt-cache.js";
import { parseSetupModelOptions, type SetupModelOptions } from "../../../scripts/runtime-setup-model-options.js";
import { defaultProviderAddress, supportsProviderAddress } from "../../../scripts/runtime-setup-provider-options.js";

export class RuntimeSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export type RuntimeSetupInput = SetupModelOptions & Readonly<{
  provider: WebSetupProvider;
  accountRef?: string;
  model: string;
  contextWindowTokens?: number;
  baseUrl?: string;
  apiKey?: string;
  deferActivation?: boolean;
  connectionRevision?: string;
}>;

export type RuntimeSetupActivation = Readonly<{
  status: "ready" | "restart_required";
  message?: string;
}>;

function readSetupString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUsableModelIdentifier(model: string): boolean {
  if (!model) return false;
  if (model.length > 256) return false;
  return !/[\u0000-\u0020\u007f]/u.test(model);
}

function isSetupConnectionRevision(value: string): boolean {
  return /^[a-f0-9-]{36}$/u.test(value);
}

function isSafeCredential(value: string): boolean {
  if (value.length > 4096) return false;
  return !/[\u0000-\u0020\u007f'"`]/u.test(value);
}

export function parseRuntimeSetupInput(
  body: Record<string, unknown> | null,
): RuntimeSetupInput {
  if (
    body?.deferActivation !== undefined &&
    typeof body.deferActivation !== "boolean"
  ) {
    throw new RuntimeSetupError(
      "invalid_setup_activation",
      "The deferred activation option must be true or false.",
    );
  }
  const connectionRevision = readSetupString(body?.connectionRevision);
  if (
    body?.connectionRevision !== undefined &&
    !isSetupConnectionRevision(connectionRevision)
  )
    throw new RuntimeSetupError(
      "invalid_setup_revision",
      "Refresh setup before editing the connection.",
    );
  let contextWindowTokens: number | undefined;
  try {
    contextWindowTokens = parseContextWindowTokens(body?.contextWindowTokens);
  } catch {
    throw new RuntimeSetupError(
      "invalid_context_window",
      "Context window must be a positive whole number of tokens.",
    );
  }
  let modelOptions: SetupModelOptions;
  try {
    modelOptions = parseSetupModelOptions(body ?? {});
  } catch (error) {
    throw new RuntimeSetupError("invalid_setup_reasoning", (error as Error).message);
  }
  const provider = readSetupString(body?.provider);
  if (!isWebSetupProvider(provider)) {
    throw new RuntimeSetupError(
      "invalid_setup_provider",
      "Choose OpenAI, Continue with ChatGPT, Ollama or llama.cpp.",
    );
  }
  try { requireSetupPromptCacheProvider(provider, modelOptions.promptCache); } catch (error) {
    throw new RuntimeSetupError("invalid_setup_prompt_cache", (error as Error).message);
  }
  let accountRef: string | undefined;
  try {
    accountRef = readSetupChatGptAccountRef(provider, body?.accountRef, { apiKey: body?.apiKey, baseUrl: body?.baseUrl });
  } catch (error) {
    throw new RuntimeSetupError("invalid_setup_account", (error as Error).message);
  }
  if (modelOptions.reasoningBudget && provider !== "llamacpp")
    throw new RuntimeSetupError("invalid_setup_reasoning", "A token reasoning budget requires llama.cpp.");
  const model = readSetupString(body?.model);
  if (!isUsableModelIdentifier(model)) {
    throw new RuntimeSetupError(
      "invalid_setup_model",
      "Enter a model ID without spaces or control characters.",
    );
  }
  const apiKey = readSetupString(body?.apiKey);
  if (!isSafeCredential(apiKey)) {
    throw new RuntimeSetupError(
      "invalid_setup_credential",
      "The API key contains unsupported characters.",
    );
  }
  if (provider === "ollama" && apiKey) {
    throw new RuntimeSetupError(
      "unexpected_setup_credential",
      "Ollama setup does not use an OpenAI API key.",
    );
  }
  const requestedBaseUrl = readSetupString(body?.baseUrl);
  if (provider === "openai" && requestedBaseUrl) {
    throw new RuntimeSetupError(
      "unexpected_setup_base_url",
      "A custom address is available for Ollama or llama.cpp.",
    );
  }
  let baseUrl: string | undefined;
  if (supportsProviderAddress(provider)) {
    try {
      baseUrl = parseBaseUrl(requestedBaseUrl || defaultProviderAddress(provider)!);
    } catch {
      throw new RuntimeSetupError(
        "invalid_setup_base_url",
        "Enter an HTTP or HTTPS origin without a path or credentials.",
      );
    }
  }
  return {
    ...modelOptions,
    provider,
    ...(accountRef ? { accountRef } : {}),
    model,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(body?.deferActivation === true ? { deferActivation: true } : {}),
    ...(connectionRevision ? { connectionRevision } : {}),
  };
}
