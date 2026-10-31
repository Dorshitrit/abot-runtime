import {
  CHATGPT_RESOURCE,
  ChatGptAuthError,
  hasPlanPermission,
  safeAccount,
  type ChatGptAccount,
  type ChatGptModel,
  type ChatGptPurpose,
} from "./contracts.js";
import { ChatGptStore, storedAccount } from "./account-store.js";
import { ChatGptTransport } from "./transport.js";
import { ChatGptIdentity } from "./discovery.js";
import { ChatGptAuthorization } from "./authorization.js";
import { ChatGptTokenSession } from "./token-session.js";
import type { ChatGptCallbackFactory } from "./callback.js";
export type ChatGptAuthOptions = {
  directory?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  callbackFactory?: ChatGptCallbackFactory;
};
export class ChatGptAuthService {
  private readonly store: ChatGptStore;
  private readonly transport: ChatGptTransport;
  private readonly authorization: ChatGptAuthorization;
  private readonly session: ChatGptTokenSession;
  constructor(options: ChatGptAuthOptions = {}) {
    this.store = new ChatGptStore(options.directory);
    this.transport = new ChatGptTransport(options.fetchImpl);
    const identity = new ChatGptIdentity(this.transport, options.now);
    this.authorization = new ChatGptAuthorization(
      this.store,
      this.transport,
      identity,
      options.now,
      options.callbackFactory,
    );
    this.session = new ChatGptTokenSession(
      this.store,
      this.transport,
      identity,
      options.now,
    );
  }
  async listAccounts(): Promise<ChatGptAccount[]> {
    return (await this.store.read()).accounts.map(safeAccount);
  }
  beginAttempt(
    options: { accountRef?: string; purpose?: ChatGptPurpose } = {},
    callbackFactory?: ChatGptCallbackFactory,
  ) {
    return this.authorization.begin(options, undefined, callbackFactory);
  }
  retryAttempt(id: string, callbackFactory?: ChatGptCallbackFactory) {
    return this.authorization.retry(id, callbackFactory);
  }
  getAttempt(id: string) {
    return this.authorization.get(id);
  }
  cancelAttempt(id: string) {
    return this.authorization.cancel(id);
  }
  async disconnect(accountRef: string) {
    this.authorization.cancelAccount(accountRef);
    return this.session.disconnect(accountRef);
  }
  async acknowledgePlan(accountRef: string): Promise<ChatGptAccount> {
    return this.store.transaction(async (store) => {
      const account = storedAccount(store, accountRef);
      if (!hasPlanPermission(account))
        throw new ChatGptAuthError(
          "chatgpt_plan_required",
          "Enable ChatGPT plan usage first.",
          403,
        );
      account.planWelcomeAcknowledged = true;
      return safeAccount(account);
    });
  }
  getAccessToken(accountRef: string, signal?: AbortSignal) {
    return this.session.accessToken(accountRef, signal);
  }
  async listModels(
    accountRef: string,
    signal?: AbortSignal,
  ): Promise<ChatGptModel[]> {
    const access = await this.getAccessToken(accountRef, signal);
    const value = (await this.transport.request(
      CHATGPT_RESOURCE + "/models",
      { headers: { authorization: "Bearer " + access } },
      signal,
    )) as { models?: unknown };
    if (!value || !Array.isArray(value.models) || value.models.length > 1000)
      throw new ChatGptAuthError(
        "chatgpt_models_invalid",
        "OpenAI returned an unsupported model catalog.",
        502,
      );
    const models: ChatGptModel[] = [];
    for (const entry of value.models) {
      if (!entry || typeof entry !== "object" || entry.visibility !== "list")
        continue;
      if (
        typeof entry.slug !== "string" ||
        !entry.slug ||
        entry.slug.length > 200 ||
        typeof entry.display_name !== "string" ||
        entry.display_name.length > 300
      )
        throw new ChatGptAuthError(
          "chatgpt_models_invalid",
          "OpenAI returned an unsupported model catalog.",
          502,
        );
      models.push({
        id: entry.slug,
        displayName: entry.display_name,
        ...(Number.isSafeInteger(entry.context_window) &&
        entry.context_window > 0
          ? { contextWindow: entry.context_window as number }
          : {}),
      });
    }
    return models;
  }
  close(): void {
    this.authorization.close();
  }
}
let service: ChatGptAuthService | undefined;
export function getChatGptAuthService(): ChatGptAuthService {
  return (service ??= new ChatGptAuthService());
}
