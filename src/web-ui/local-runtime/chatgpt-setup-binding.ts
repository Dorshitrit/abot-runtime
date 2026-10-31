import { requireChatGptAccountRef } from "../../provider-auth/chatgpt/contracts.js";
import { getChatGptAuthService } from "../../provider-auth/chatgpt/service.js";
import { isRecord } from "../../runtime/config/utils.js";

/** Setup accepts a local account reference, never credentials or a custom OAuth host. */
export function readSetupChatGptAccountRef(
  provider: string,
  value: unknown,
  credentials: {
    apiKey?: unknown;
    apiKeyEnv?: unknown;
    useApiKey?: unknown;
    baseUrl?: unknown;
  } = {},
): string | undefined {
  const hasUnexpectedAccountReference =
    provider !== "openai-chatgpt" && value !== undefined;
  if (hasUnexpectedAccountReference)
    throw new Error(
      "A ChatGPT account can only be used with Continue with ChatGPT.",
    );
  if (provider !== "openai-chatgpt") return undefined;
  const hasCredentialOverride = Object.values(credentials).some(
    (value) => value !== undefined && value !== "",
  );
  if (hasCredentialOverride)
    throw new Error(
      "Continue with ChatGPT uses its saved account and the official OpenAI address.",
    );
  return requireChatGptAccountRef(value);
}

export function chatGptSetupMetadata(provider: unknown) {
  if (!isRecord(provider) || provider.type !== "openai-chatgpt") return {};
  const settings = isRecord(provider.settings) ? provider.settings : {};
  return {
    authentication: "chatgpt" as const,
    accountRef: requireChatGptAccountRef(settings.accountRef),
  };
}

/** Validate the selected saved identity before writing a model or setup transaction. */
export async function requireConnectedChatGptSetupAccount(
  provider: unknown,
): Promise<void> {
  const metadata = chatGptSetupMetadata(provider);
  if (!metadata.accountRef) return;
  const account = (await getChatGptAuthService().listAccounts()).find(
    (entry) => entry.accountRef === metadata.accountRef,
  );
  if (!account || account.status !== "connected")
    throw new Error("Connect this ChatGPT account before saving the model.");
  if (!account.planEnabled)
    throw new Error(
      "Allow ChatGPT plan usage for this account before saving the model.",
    );
}
