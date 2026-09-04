import type { PublicHttpResponse } from "../../public-http.js";

function header(
  response: PublicHttpResponse,
  name: string,
): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

function parseDeltaSeconds(value: string): number {
  if (!/^\d+$/u.test(value)) return Number.NaN;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : Number.NaN;
}

function explicitFreshnessLifetime(
  response: PublicHttpResponse,
  directives: readonly string[],
  responseDate: number,
  fallback: number,
): number {
  const maxAge = directives.filter(
    (value) => value.split("=", 1)[0]!.trim() === "max-age",
  );
  if (maxAge.length > 1) return 0;
  if (maxAge.length === 1) {
    const value = maxAge[0]!.match(/^max-age\s*=\s*(?:"(\d+)"|(\d+))$/u);
    if (!value) return 0;
    return parseDeltaSeconds(value[1] ?? value[2]!);
  }
  const expires = header(response, "expires");
  if (expires === undefined) return fallback;
  return Date.parse(expires) - responseDate;
}

export function httpCacheFreshnessMs(
  response: PublicHttpResponse,
  maximum: number,
  now: number,
): number {
  const directives = (header(response, "cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  const names = new Set(
    directives.map((value) => value.split("=", 1)[0]!.trim()),
  );
  if (names.has("no-store")) return 0;
  if (names.has("no-cache")) return 0;

  const date = header(response, "date");
  const responseDate = date === undefined ? now : Date.parse(date);
  const rawAge = header(response, "age");
  const age = rawAge === undefined ? 0 : parseDeltaSeconds(rawAge.trim());
  const lifetime = explicitFreshnessLifetime(
    response,
    directives,
    responseDate,
    maximum,
  );
  // Invalid or conflicting origin freshness never earns a default cache lifetime.
  if (!Number.isFinite(responseDate)) return 0;
  if (!Number.isFinite(age)) return 0;
  if (!Number.isFinite(lifetime)) return 0;
  const currentAge = Math.max(0, now - responseDate, age);
  return Math.min(maximum, Math.max(0, lifetime - currentAge));
}
