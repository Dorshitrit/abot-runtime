import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGptIdentity } from "../discovery.js";
import { ChatGptTransport } from "../transport.js";
import { CHATGPT_ISSUER } from "../contracts.js";

describe("ChatGPT OpenID validation", () => {
  it("validates signatures and rejects wrong nonce, issuer, audience, expiry and authorized party", async () => {
    const pair = await generateKeyPair("ES256");
    const key = {
      ...(await exportJWK(pair.publicKey)),
      kid: "key",
      alg: "ES256",
    };
    const now = 1800000000000;
    const transport = new ChatGptTransport((async (input) => {
      if (String(input).endsWith("openid-configuration"))
        return Response.json({
          issuer: CHATGPT_ISSUER,
          authorization_endpoint: "https://ignored.example/authorize",
          token_endpoint: "https://ignored.example/token",
          jwks_uri: CHATGPT_ISSUER + "/jwks",
          revocation_endpoint: CHATGPT_ISSUER + "/revoke",
        });
      return Response.json({ keys: [key] });
    }) as typeof fetch);
    const identity = new ChatGptIdentity(transport, () => now);
    const sign = (changes: Record<string, unknown> = {}) =>
      new SignJWT({
        sub: "user",
        iss: CHATGPT_ISSUER,
        aud: "oaiapp_client",
        nonce: "nonce",
        iat: now / 1000,
        exp: now / 1000 + 60,
        ...changes,
      })
        .setProtectedHeader({ alg: "ES256", kid: "key" })
        .sign(pair.privateKey);
    expect(
      (await identity.verify(await sign(), "oaiapp_client", "nonce")).sub,
    ).toBe("user");
    expect(await identity.discovery()).toMatchObject({
      authorization_endpoint: CHATGPT_ISSUER + "/api/accounts/authorize",
      token_endpoint: CHATGPT_ISSUER + "/api/accounts/oauth/token",
    });
    for (const changes of [
      { nonce: "other" },
      { iss: "https://attacker.example" },
      { aud: "other" },
      { exp: now / 1000 - 20 },
      { sub: "" },
      { iat: now / 1000 + 60 },
      { azp: "other" },
      { aud: ["oaiapp_client", "other"] },
    ]) {
      await expect(
        identity.verify(await sign(changes), "oaiapp_client", "nonce"),
      ).rejects.toMatchObject({ code: "chatgpt_identity_invalid" });
    }
    const another = await generateKeyPair("ES256");
    const wrongSignature = await new SignJWT({ sub: "user", nonce: "nonce" })
      .setProtectedHeader({ alg: "ES256", kid: "key" })
      .setIssuer(CHATGPT_ISSUER)
      .setAudience("oaiapp_client")
      .setIssuedAt(now / 1000)
      .setExpirationTime(now / 1000 + 60)
      .sign(another.privateKey);
    await expect(
      identity.verify(wrongSignature, "oaiapp_client", "nonce"),
    ).rejects.toMatchObject({ code: "chatgpt_identity_invalid" });
    const unsigned =
      Buffer.from('{"alg":"none"}').toString("base64url") +
      "." +
      Buffer.from('{"sub":"user"}').toString("base64url") +
      ".";
    await expect(
      identity.verify(unsigned, "oaiapp_client", "nonce"),
    ).rejects.toMatchObject({ code: "chatgpt_identity_invalid" });
  });
  it("rejects cross-origin discovery keys and transport redirects without exposing response text", async () => {
    const identity = new ChatGptIdentity(
      new ChatGptTransport((async () =>
        Response.json({
          issuer: CHATGPT_ISSUER,
          jwks_uri: "https://attacker.example/jwks",
          revocation_endpoint: CHATGPT_ISSUER + "/revoke",
        })) as typeof fetch),
    );
    await expect(identity.discovery()).rejects.toMatchObject({
      code: "chatgpt_endpoint_invalid",
    });
    const transport = new ChatGptTransport((async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ error_description: "SECRET" }, { status: 500 });
    }) as typeof fetch);
    await expect(
      transport.request(CHATGPT_ISSUER + "/token"),
    ).rejects.toMatchObject({
      message: "OpenAI could not complete this account request.",
    });
    await expect(
      transport.request("https://attacker.example/token"),
    ).rejects.toMatchObject({ code: "chatgpt_endpoint_invalid" });
  });
});
