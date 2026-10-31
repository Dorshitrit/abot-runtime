import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { CHATGPT_ISSUER, ChatGptAuthError } from "./contracts.js";
import { ChatGptTransport, requireOpenAiUrl } from "./transport.js";

export type ChatGptDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
};
export class ChatGptIdentity {
  private metadata?: { expiresAt: number; value: ChatGptDiscovery };
  private keys?: {
    expiresAt: number;
    resolve: ReturnType<typeof createLocalJWKSet>;
  };
  constructor(
    private readonly transport: ChatGptTransport,
    private readonly now = Date.now,
  ) {}
  async discovery(signal?: AbortSignal): Promise<ChatGptDiscovery> {
    if (this.metadata && this.metadata.expiresAt > this.now())
      return this.metadata.value;
    const value = (await this.transport.request(
      CHATGPT_ISSUER + "/.well-known/openid-configuration",
      {},
      signal,
    )) as ChatGptDiscovery;
    if (!value || value.issuer !== CHATGPT_ISSUER)
      throw new ChatGptAuthError(
        "chatgpt_issuer_invalid",
        "OpenAI identity configuration is unavailable.",
        502,
      );
    for (const key of ["jwks_uri", "revocation_endpoint"] as const) {
      if (typeof value[key] !== "string")
        throw new ChatGptAuthError(
          "chatgpt_endpoint_invalid",
          "OpenAI identity configuration is incomplete.",
          502,
        );
      requireOpenAiUrl(value[key], CHATGPT_ISSUER);
    }
    const metadata = {
      issuer: CHATGPT_ISSUER,
      authorization_endpoint: CHATGPT_ISSUER + "/api/accounts/authorize",
      token_endpoint: CHATGPT_ISSUER + "/api/accounts/oauth/token",
      jwks_uri: value.jwks_uri,
      revocation_endpoint: value.revocation_endpoint,
    };
    this.metadata = { value: metadata, expiresAt: this.now() + 3600000 };
    return metadata;
  }
  private async jwks(force: boolean, signal?: AbortSignal) {
    if (!force && this.keys && this.keys.expiresAt > this.now())
      return this.keys.resolve;
    const metadata = await this.discovery(signal);
    const value = (await this.transport.request(
      metadata.jwks_uri,
      {},
      signal,
    )) as JSONWebKeySet;
    if (!value || !Array.isArray(value.keys) || value.keys.length > 32)
      throw new ChatGptAuthError(
        "chatgpt_identity_invalid",
        "OpenAI signing keys are unavailable.",
        502,
      );
    const resolve = createLocalJWKSet(value);
    this.keys = { resolve, expiresAt: this.now() + 600000 };
    return resolve;
  }
  async verify(
    token: string,
    clientId: string,
    nonce?: string,
    signal?: AbortSignal,
  ): Promise<JWTPayload> {
    if (token.length > 32768)
      throw new ChatGptAuthError(
        "chatgpt_identity_invalid",
        "OpenAI identity could not be verified.",
        502,
      );
    const options = {
      issuer: CHATGPT_ISSUER,
      audience: clientId,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
      algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
      currentDate: new Date(this.now()),
    };
    try {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(
          token,
          await this.jwks(false, signal),
          options,
        ));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ERR_JWKS_NO_MATCHING_KEY"
        )
          throw error;
        ({ payload } = await jwtVerify(
          token,
          await this.jwks(true, signal),
          options,
        ));
      }
      if (
        typeof payload.sub !== "string" ||
        !payload.sub ||
        payload.sub.length > 512
      )
        throw new Error("subject");
      if (
        typeof payload.iat !== "number" ||
        payload.iat > this.now() / 1000 + 5
      )
        throw new Error("issued_at");
      if (nonce !== undefined && payload.nonce !== nonce)
        throw new Error("nonce");
      if (payload.azp !== undefined && payload.azp !== clientId)
        throw new Error("authorized_party");
      if (
        Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId
      )
        throw new Error("authorized_party");
      return payload;
    } catch {
      throw new ChatGptAuthError(
        "chatgpt_identity_invalid",
        "OpenAI identity could not be verified.",
        502,
      );
    }
  }
}
