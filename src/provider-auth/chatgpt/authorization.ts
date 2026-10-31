import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  CHATGPT_PLAN_SCOPE,
  CHATGPT_RESOURCE,
  ChatGptAuthError,
  authFailure,
  requireChatGptAccountRef,
  type ChatGptAttempt,
  type ChatGptPurpose,
} from "./contracts.js";
import {
  ChatGptStore,
  storedAccount,
  accountAuthorizationRevision,
  requireAccountAuthorizationRevision,
} from "./account-store.js";
import {
  createChatGptCallback,
  type ChatGptCallback,
  type ChatGptCallbackFactory,
} from "./callback.js";
import { ChatGptIdentity } from "./discovery.js";
import { ChatGptTransport } from "./transport.js";
import { completeChatGptRegistration } from "./registration.js";

type PendingAttempt = {
  public: ChatGptAttempt;
  state: string;
  nonce: string;
  verifier: string;
  accountRef?: string;
  clientId?: string;
  callback?: ChatGptCallback;
  timer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  consumed: boolean;
  committing: boolean;
  hostId: string;
  purpose?: ChatGptPurpose;
  accountGeneration: number;
  authorizationRevision?: number;
};
function equalState(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}
function issuedClientId(value: string | null): string {
  if (
    !value ||
    value === "dynamic_agent_client" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(value)
  )
    throw new ChatGptAuthError(
      "chatgpt_registration_incomplete",
      "OpenAI did not return a completed app registration.",
      502,
    );
  return value;
}
export class ChatGptAuthorization {
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly accountGenerations = new Map<string, number>();
  constructor(
    private readonly store: ChatGptStore,
    private readonly transport: ChatGptTransport,
    private readonly identity: ChatGptIdentity,
    private readonly now = Date.now,
    private readonly callbackFactory: ChatGptCallbackFactory = createChatGptCallback,
  ) {}
  async begin(
    options: { accountRef?: string; purpose?: ChatGptPurpose } = {},
    retained?: { clientId: string; hostId: string },
    callbackFactory: ChatGptCallbackFactory = this.callbackFactory,
  ): Promise<ChatGptAttempt> {
    if (
      options.purpose !== undefined &&
      options.purpose !== "sign_in" &&
      options.purpose !== "enable_plan_usage"
    )
      throw new ChatGptAuthError(
        "chatgpt_attempt_invalid",
        "Choose a supported sign-in action.",
      );
    if (options.accountRef !== undefined)
      requireChatGptAccountRef(options.accountRef);
    if (options.purpose === "enable_plan_usage" && !options.accountRef)
      throw new ChatGptAuthError(
        "chatgpt_account_required",
        "Choose the ChatGPT account to enable.",
      );
    for (const [id, attempt] of this.attempts)
      if (attempt.public.expiresAt + 600000 < this.now())
        this.attempts.delete(id);
    if (this.attempts.size >= 32)
      throw new ChatGptAuthError(
        "chatgpt_attempt_limit",
        "Finish or cancel the current sign-in attempts.",
        429,
      );
    if (options.accountRef) this.cancelAccount(options.accountRef);
    const accountGeneration = this.currentAccountGeneration(options.accountRef);
    const store = await this.store.read();
    this.requireAccountGeneration(options.accountRef, accountGeneration);
    if (retained && retained.hostId !== store.hostId)
      throw new ChatGptAuthError(
        "chatgpt_host_changed",
        "Start a new sign-in for this ABot installation.",
        409,
      );
    const account = options.accountRef
      ? storedAccount(store, options.accountRef)
      : undefined;
    const clientId = account?.clientId ?? retained?.clientId;
    const metadata = await this.identity.discovery();
    this.requireAccountGeneration(options.accountRef, accountGeneration);
    const attempt: PendingAttempt = {
      public: {
        attemptId: randomUUID(),
        status: "pending",
        expiresAt: this.now() + 600000,
      },
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"),
      ...(account
        ? {
            accountRef: account.accountRef,
            authorizationRevision: accountAuthorizationRevision(account),
          }
        : {}),
      ...(clientId ? { clientId } : {}),
      hostId: store.hostId,
      purpose: options.purpose,
      abort: new AbortController(),
      consumed: false,
      committing: false,
      accountGeneration,
    };
    attempt.callback = await callbackFactory(
      (parameters) => this.consume(attempt, parameters),
      { state: attempt.state },
    );
    try {
      if (attempt.accountRef) {
        const current = await this.store.read();
        requireAccountAuthorizationRevision(
          storedAccount(current, attempt.accountRef),
          attempt.authorizationRevision ?? 0,
        );
      }
      this.requireAccountGeneration(options.accountRef, accountGeneration);
    } catch (error) {
      attempt.callback.close();
      throw error;
    }
    this.attempts.set(attempt.public.attemptId, attempt);
    const url = new URL(metadata.authorization_endpoint);
    const values = {
      client_id: clientId ?? "dynamic_agent_client",
      ext_agent_host_id: store.hostId,
      response_type: "code",
      redirect_uri: attempt.callback.redirectUri,
      scope:
        "openid profile email offline_access resource.invoke " +
        CHATGPT_PLAN_SCOPE,
      resource: CHATGPT_RESOURCE,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(attempt.verifier)
        .digest("base64url"),
    };
    for (const [key, value] of Object.entries(values))
      url.searchParams.set(key, value);
    if (!clientId) url.searchParams.set("agent_name_hint", "ABot");
    if (options.purpose === "enable_plan_usage")
      url.searchParams.set("prompt", "consent");
    attempt.public.authorizationUrl = url.toString();
    attempt.timer = setTimeout(() => {
      if (!attempt.committing) this.cancel(attempt.public.attemptId);
    }, 600000);
    attempt.timer.unref();
    return { ...attempt.public };
  }
  async retry(
    id: string,
    callbackFactory: ChatGptCallbackFactory = this.callbackFactory,
  ): Promise<ChatGptAttempt> {
    const previous = this.attempts.get(requireChatGptAccountRef(id));
    if (!previous?.public.retryable || !previous.clientId)
      throw new ChatGptAuthError(
        "chatgpt_retry_unavailable",
        "Start a new ChatGPT sign-in.",
      );
    const next = await this.begin(
      { accountRef: previous.accountRef, purpose: previous.purpose },
      { clientId: previous.clientId, hostId: previous.hostId },
      callbackFactory,
    );
    previous.public.retryable = false;
    return next;
  }
  get(id: string): ChatGptAttempt {
    const attempt = this.attempts.get(requireChatGptAccountRef(id));
    if (!attempt)
      throw new ChatGptAuthError(
        "chatgpt_attempt_not_found",
        "This sign-in attempt is no longer available.",
        404,
      );
    if (
      attempt.public.status === "pending" &&
      !attempt.committing &&
      attempt.public.expiresAt <= this.now()
    )
      this.cancel(id);
    return { ...attempt.public };
  }
  cancel(id: string): ChatGptAttempt {
    const attempt = this.attempts.get(requireChatGptAccountRef(id));
    if (!attempt)
      throw new ChatGptAuthError(
        "chatgpt_attempt_not_found",
        "This sign-in attempt is no longer available.",
        404,
      );
    if (attempt.public.status !== "pending") return { ...attempt.public };
    if (attempt.committing)
      throw new ChatGptAuthError(
        "chatgpt_attempt_completing",
        "Sign-in is being saved. Wait for completion.",
        409,
      );
    attempt.public.status = "cancelled";
    attempt.abort.abort();
    this.finish(attempt);
    return { ...attempt.public };
  }
  private currentAccountGeneration(accountRef?: string): number {
    return accountRef ? (this.accountGenerations.get(accountRef) ?? 0) : 0;
  }
  private requireAccountGeneration(
    accountRef: string | undefined,
    generation: number,
  ): void {
    if (this.currentAccountGeneration(accountRef) !== generation)
      throw new ChatGptAuthError(
        "chatgpt_attempt_cancelled",
        "This sign-in was cancelled by another account action.",
        409,
      );
  }
  cancelAccount(accountRef: string): void {
    this.accountGenerations.set(
      accountRef,
      this.currentAccountGeneration(accountRef) + 1,
    );
    for (const attempt of this.attempts.values())
      if (
        attempt.accountRef === accountRef &&
        attempt.public.status === "pending" &&
        !attempt.committing
      )
        this.cancel(attempt.public.attemptId);
  }
  close(): void {
    for (const attempt of this.attempts.values())
      if (attempt.public.status === "pending" && !attempt.committing)
        this.cancel(attempt.public.attemptId);
  }
  private finish(attempt: PendingAttempt): void {
    clearTimeout(attempt.timer);
    attempt.callback?.close();
    delete attempt.public.authorizationUrl;
    attempt.state = "";
    attempt.verifier = "";
    attempt.nonce = "";
  }
  private async consume(
    attempt: PendingAttempt,
    parameters: URLSearchParams,
  ): Promise<void> {
    if (
      attempt.public.status !== "pending" ||
      attempt.consumed ||
      attempt.public.expiresAt <= this.now()
    )
      throw new ChatGptAuthError(
        "chatgpt_attempt_expired",
        "Start a new ChatGPT sign-in.",
      );
    if (!equalState(parameters.get("state"), attempt.state))
      throw new ChatGptAuthError(
        "chatgpt_state_invalid",
        "The sign-in callback did not match.",
      );
    attempt.consumed = true;
    try {
      if (parameters.has("error"))
        throw new ChatGptAuthError(
          "chatgpt_access_denied",
          "ChatGPT sign-in was not authorized.",
        );
      const returnedClient = parameters.get("client_id");
      const clientId = issuedClientId(attempt.clientId ?? returnedClient);
      if (returnedClient !== null && returnedClient !== clientId)
        throw new ChatGptAuthError(
          "chatgpt_account_mismatch",
          "The sign-in registration did not match this account.",
        );
      attempt.clientId = clientId;
      const code = parameters.get("code");
      if (!code || code.length > 4096)
        throw new ChatGptAuthError(
          "chatgpt_code_missing",
          "OpenAI did not return a sign-in code.",
        );
      const accountRef = await completeChatGptRegistration(
        this.store,
        this.transport,
        this.identity,
        this.now,
        {
          accountRef: attempt.accountRef,
          authorizationRevision: attempt.authorizationRevision,
          clientId,
          code,
          verifier: attempt.verifier,
          redirectUri: attempt.callback!.redirectUri,
          nonce: attempt.nonce,
          signal: attempt.abort.signal,
          beginCommit: () => {
            this.requireAccountGeneration(
              attempt.accountRef,
              attempt.accountGeneration,
            );
            attempt.committing = true;
          },
        },
      );
      attempt.public.status = "complete";
      attempt.public.accountRef = accountRef;
    } catch (error) {
      if (!attempt.abort.signal.aborted) {
        const failure = authFailure(error);
        attempt.public.status = "failed";
        attempt.public.error = { code: failure.code, message: failure.message };
        attempt.public.retryable =
          failure.code === "chatgpt_reauth_required" &&
          attempt.clientId !== undefined;
      }
      throw error;
    } finally {
      this.finish(attempt);
    }
  }
}
