import { ChatGptAuthError, type ChatGptTokens } from "./contracts.js";
export function readTokenResponse(
  value: unknown,
  now: number,
  previous?: ChatGptTokens,
): ChatGptTokens {
  if (!value || typeof value !== "object")
    throw new ChatGptAuthError(
      "chatgpt_tokens_invalid",
      "OpenAI returned incomplete credentials.",
      502,
    );
  const row = value as Record<string, unknown>;
  for (const key of ["access_token", "refresh_token", "id_token"]) {
    if (row[key] === undefined && key !== "access_token") continue;
    if (typeof row[key] !== "string" || !row[key] || row[key].length > 32768)
      throw new ChatGptAuthError(
        "chatgpt_tokens_invalid",
        "OpenAI returned incomplete credentials.",
        502,
      );
  }
  if (
    typeof row.token_type !== "string" ||
    row.token_type.toLowerCase() !== "bearer"
  )
    throw new ChatGptAuthError(
      "chatgpt_tokens_invalid",
      "OpenAI returned an unsupported credential type.",
      502,
    );
  if (
    typeof row.expires_in !== "number" ||
    !Number.isFinite(row.expires_in) ||
    row.expires_in <= 0 ||
    row.expires_in > 86400
  )
    throw new ChatGptAuthError(
      "chatgpt_tokens_invalid",
      "OpenAI returned an invalid credential lifetime.",
      502,
    );
  if (
    row.scope !== undefined &&
    (typeof row.scope !== "string" || row.scope.length > 6000)
  )
    throw new ChatGptAuthError(
      "chatgpt_tokens_invalid",
      "OpenAI returned invalid permissions.",
      502,
    );
  const idToken =
    typeof row.id_token === "string" ? row.id_token : previous?.idToken;
  if (!idToken)
    throw new ChatGptAuthError(
      "chatgpt_tokens_invalid",
      "OpenAI did not return an identity token.",
      502,
    );
  const scopes =
    typeof row.scope === "string"
      ? row.scope.split(/\s+/u).filter(Boolean)
      : (previous?.scopes ?? []);
  const refreshToken =
    typeof row.refresh_token === "string"
      ? row.refresh_token
      : previous?.refreshToken;
  if (previous?.refreshToken && typeof row.refresh_token !== "string")
    throw new ChatGptAuthError(
      "chatgpt_tokens_invalid",
      "OpenAI did not return replacement credentials.",
      502,
    );
  return {
    accessToken: row.access_token as string,
    idToken,
    ...(refreshToken ? { refreshToken } : {}),
    scopes,
    expiresAt: now + row.expires_in * 1000,
    ...(typeof row.earliest_refresh_at === "number" &&
    Number.isFinite(row.earliest_refresh_at)
      ? { earliestRefreshAt: row.earliest_refresh_at * 1000 }
      : {}),
  };
}
