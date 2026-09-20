import {
  parseBaseUrl,
  parseContextWindowTokens,
} from "../../../scripts/runtime-setup-files.js";

export class RuntimeSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export type RuntimeSetupInput = Readonly<{
  provider: "openai" | "ollama";
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
  const provider = readSetupString(body?.provider);
  if (provider !== "openai" && provider !== "ollama") {
    throw new RuntimeSetupError(
      "invalid_setup_provider",
      "Choose OpenAI or Ollama.",
    );
  }
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
      "A custom address is available for Ollama.",
    );
  }
  let baseUrl: string | undefined;
  if (provider === "ollama") {
    try {
      baseUrl = parseBaseUrl(requestedBaseUrl || "http://127.0.0.1:11434");
    } catch {
      throw new RuntimeSetupError(
        "invalid_setup_base_url",
        "Enter an HTTP or HTTPS origin without a path or credentials.",
      );
    }
  }
  return {
    provider,
    model,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(body?.deferActivation === true ? { deferActivation: true } : {}),
    ...(connectionRevision ? { connectionRevision } : {}),
  };
}
