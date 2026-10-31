type ProviderUserErrorCode = "ollama_unreachable" | "ollama_model_not_found";

export type ProviderUserErrorPresentation = Readonly<{
  code: ProviderUserErrorCode;
  endpoint?: string;
  model?: string;
}>;

type ProviderUserError = ProviderUserErrorPresentation & Readonly<{
  kind: "model_provider_user_error_v1";
}>;

export const PROVIDER_USER_ERROR_HEADER = "x-abot-model-error-presentation";
const MAX_HEADER_LENGTH = 4_096;

/** Only the gateway serializes adapter-owned presentation into this HTTP header. */
export function encodeProviderUserError(
  options: ProviderUserErrorPresentation,
): string | undefined {
  if (!isProviderUserErrorCode(options.code)) return undefined;
  const body = JSON.stringify({
    kind: "model_provider_user_error_v1",
    code: options.code,
    endpoint: safeProviderEndpoint(options.endpoint),
    model: safeOllamaModelId(options.model),
  } satisfies ProviderUserError);
  if (body.length > 2_048) return undefined;
  const header = encodeURIComponent(body);
  return header.length <= MAX_HEADER_LENGTH ? header : undefined;
}

export function readProviderUserErrorMessage(header: string | null | undefined): string | undefined {
  if (!header || header.length > MAX_HEADER_LENGTH) return undefined;
  let value: unknown;
  try {
    const body = decodeURIComponent(header);
    if (body.length > 2_048) return undefined;
    value = JSON.parse(body);
  } catch { return undefined; }
  if (!isProviderUserError(value)) return undefined;
  const endpoint = safeProviderEndpoint(value.endpoint);
  const address = endpoint ? ` at ${endpoint}` : "";
  if (value.code === "ollama_unreachable")
    return `Can't reach Ollama${address}. Check that Ollama is running and that its address is correct.`;
  const model = safeOllamaModelId(value.model);
  if (!model)
    return `The selected model isn't installed in Ollama${address}. Install the model on the machine running Ollama, then try again.`;
  return `Model "${model}" isn't installed in Ollama${address}. Run \`ollama pull ${model}\` on the machine running Ollama, then try again.`;
}

function isProviderUserError(value: unknown): value is ProviderUserError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "model_provider_user_error_v1") return false;
  return isProviderUserErrorCode(record.code);
}

function isProviderUserErrorCode(code: unknown): code is ProviderUserErrorCode {
  return code === "ollama_unreachable" || code === "ollama_model_not_found";
}

function safeProviderEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch { return undefined; }
}

function safeOllamaModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(value) ? value : undefined;
}
