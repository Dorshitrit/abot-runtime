import { onTestFinished } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ChatGptAuthService } from "../service.js";
import { CHATGPT_ISSUER, CHATGPT_PLAN_SCOPE } from "../contracts.js";
import type { ChatGptPurpose } from "../contracts.js";
export async function authFixture() {
  const artifacts = resolve(
    ".codex/artifacts/continue-with-chatgpt/auth-tests",
  );
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "account-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const pair = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "fixture",
    alg: "ES256",
    use: "sig",
  };
  let now = 1800000000000;
  let nonce = "";
  let subject = "fixture-subject";
  let scopes =
    "openid email profile offline_access resource.invoke " + CHATGPT_PLAN_SCOPE;
  let tokenError: string | undefined;
  let revokeFails = false;
  let refreshes = 0;
  let consumes: Array<(parameters: URLSearchParams) => Promise<void>> = [];
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const jwt = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: subject,
      nonce,
      email: "fixture@example.test",
      ...overrides,
    })
      .setProtectedHeader({ alg: "ES256", kid: "fixture" })
      .setIssuer(CHATGPT_ISSUER)
      .setAudience("oaiapp_fixture")
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + 3600)
      .sign(pair.privateKey);
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/openid-configuration"))
      return Response.json({
        issuer: CHATGPT_ISSUER,
        authorization_endpoint: CHATGPT_ISSUER + "/api/accounts/authorize",
        token_endpoint: CHATGPT_ISSUER + "/api/accounts/oauth/token",
        jwks_uri: CHATGPT_ISSUER + "/.well-known/jwks.json",
        revocation_endpoint: CHATGPT_ISSUER + "/oauth/revoke",
      });
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/oauth/revoke"))
      return new Response(null, { status: revokeFails ? 503 : 200 });
    if (url.endsWith("/oauth/token")) {
      if (tokenError)
        return Response.json({ error: tokenError }, { status: 400 });
      const form = new URLSearchParams(String(init?.body));
      const refresh = form.get("grant_type") === "refresh_token";
      if (refresh) refreshes++;
      return Response.json({
        access_token: "ACCESS-" + refreshes,
        refresh_token: "REFRESH-" + refreshes,
        ...(!refresh ? { id_token: await jwt() } : {}),
        token_type: "Bearer",
        expires_in: 3600,
        scope: scopes,
      });
    }
    if (url.endsWith("/models"))
      return Response.json({
        models: [
          {
            slug: "visible-b",
            display_name: "Visible B",
            visibility: "list",
            context_window: 20000,
          },
          { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
          { slug: "visible-a", display_name: "Visible A", visibility: "list" },
        ],
      });
    throw new Error("Unexpected fixture endpoint");
  }) as typeof fetch;
  const options = {
    directory,
    fetchImpl,
    now: () => now,
    callbackFactory: async (
      consume: (parameters: URLSearchParams) => Promise<void>,
    ) => {
      consumes.push(consume);
      return {
        redirectUri: "http://127.0.0.1:32123/auth/callback",
        close() {},
      };
    },
  };
  const service = new ChatGptAuthService(options);
  async function begin(accountRef?: string, purpose?: ChatGptPurpose) {
    const attempt = await service.beginAttempt({
      ...(accountRef ? { accountRef } : {}),
      ...(purpose ? { purpose } : {}),
    });
    const url = new URL(attempt.authorizationUrl!);
    nonce = url.searchParams.get("nonce")!;
    return { attempt, url, consume: consumes.at(-1)! };
  }
  async function signIn(accountRef?: string) {
    const started = await begin(accountRef);
    await started.consume(
      new URLSearchParams({
        state: started.url.searchParams.get("state")!,
        code: "fixture-code",
        client_id: "oaiapp_fixture",
      }),
    );
    return service.getAttempt(started.attempt.attemptId).accountRef!;
  }
  return {
    service,
    directory,
    options,
    begin,
    signIn,
    jwt,
    jwk,
    fetchImpl,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    nonce: (value: string) => {
      nonce = value;
    },
    refreshes: () => refreshes,
    scopes: (value: string) => {
      scopes = value;
    },
    subject: (value: string) => {
      subject = value;
    },
    tokenError: (value: string | undefined) => {
      tokenError = value;
    },
    revokeFails: () => {
      revokeFails = true;
    },
  };
}
