import {
  CHATGPT_RESOURCE,
  ChatGptAuthError,
  hasPlanPermission,
} from "./contracts.js";
import {
  ChatGptStore,
  storedAccount,
  accountAuthorizationRevision,
} from "./account-store.js";
import { ChatGptIdentity } from "./discovery.js";
import { ChatGptTransport } from "./transport.js";
import { readTokenResponse } from "./token-response.js";

export class ChatGptTokenSession {
  constructor(
    private readonly store: ChatGptStore,
    private readonly transport: ChatGptTransport,
    private readonly identity: ChatGptIdentity,
    private readonly now = Date.now,
  ) {}
  async accessToken(accountRef: string, signal?: AbortSignal): Promise<string> {
    const result = await this.store.transaction(async (value) => {
      signal?.throwIfAborted();
      const account = storedAccount(value, accountRef);
      if (!account.tokens || account.reauthRequired)
        throw new ChatGptAuthError(
          "chatgpt_reauth_required",
          "Sign in to this ChatGPT account again.",
          401,
        );
      if (!hasPlanPermission(account))
        throw new ChatGptAuthError(
          "chatgpt_plan_required",
          "Enable ChatGPT plan usage for this account.",
          403,
        );
      const old = account.tokens;
      if (old.expiresAt > this.now() + 60000) return { token: old.accessToken };
      if (
        old.earliestRefreshAt &&
        old.earliestRefreshAt > this.now() &&
        old.expiresAt > this.now()
      )
        return { token: old.accessToken };
      if (!old.refreshToken) {
        account.reauthRequired = true;
        return { reauth: true };
      }
      try {
        const metadata = await this.identity.discovery(signal);
        const response = await this.transport.form(
          metadata.token_endpoint,
          {
            grant_type: "refresh_token",
            client_id: account.clientId,
            refresh_token: old.refreshToken,
            resource: CHATGPT_RESOURCE,
          },
          signal,
        );
        const tokens = readTokenResponse(response, this.now(), old);
        if (tokens.idToken !== old.idToken) {
          const claims = await this.identity.verify(
            tokens.idToken,
            account.clientId,
            undefined,
            signal,
          );
          if (claims.sub !== account.subject)
            throw new ChatGptAuthError(
              "chatgpt_identity_invalid",
              "The renewed ChatGPT identity did not match this account.",
              401,
            );
        }
        account.tokens = tokens;
        if (!hasPlanPermission(account)) return { planRequired: true };
        return { token: tokens.accessToken };
      } catch (error) {
        if (
          !(error instanceof ChatGptAuthError) ||
          error.code !== "chatgpt_reauth_required"
        )
          throw error;
        account.reauthRequired = true;
        delete account.tokens;
        return { reauth: true };
      }
    });
    signal?.throwIfAborted();
    if (result.reauth)
      throw new ChatGptAuthError(
        "chatgpt_reauth_required",
        "Sign in to this ChatGPT account again.",
        401,
      );
    if (result.planRequired)
      throw new ChatGptAuthError(
        "chatgpt_plan_required",
        "Enable ChatGPT plan usage for this account.",
        403,
      );
    return result.token!;
  }
  async disconnect(
    accountRef: string,
  ): Promise<{ revocationConfirmed: boolean; message?: string }> {
    return this.store.transaction(async (value) => {
      const account = storedAccount(value, accountRef);
      account.authorizationRevision = accountAuthorizationRevision(account) + 1;
      let revoked = !account.tokens?.refreshToken;
      if (account.tokens?.refreshToken) {
        try {
          const metadata = await this.identity.discovery();
          await this.transport.form(metadata.revocation_endpoint, {
            token: account.tokens.refreshToken,
            token_type_hint: "refresh_token",
            client_id: account.clientId,
          });
          revoked = true;
        } catch {
          revoked = false;
        }
      }
      delete account.tokens;
      delete account.reauthRequired;
      return {
        revocationConfirmed: revoked,
        ...(!revoked
          ? {
              message:
                "Signed out locally. OpenAI revocation was not confirmed; disconnect this app in ChatGPT Settings.",
            }
          : {}),
      };
    });
  }
}
