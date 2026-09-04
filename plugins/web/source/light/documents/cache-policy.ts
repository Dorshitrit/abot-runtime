import type { PublicHttpResponse } from "../../public-http.js";
import type { LightConfig } from "../config.js";
import type { LightDocument } from "./document-contract.js";
import { httpCacheFreshnessMs } from "./http-cache-freshness.js";

function header(response: PublicHttpResponse, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

export function documentExpiresAt(
  response: PublicHttpResponse,
  kind: LightDocument["kind"],
  config: LightConfig,
  now: number,
): number {
  const directives = header(response, "cache-control")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  const names = new Set(
    directives.map((value) => value.split("=", 1)[0]!.trim()),
  );
  if (names.has("private")) return now;
  if (header(response, "vary").trim() === "*") return now;
  const maximum = kind === "page" ? config.pageTtlMs : config.feedTtlMs;
  return now + httpCacheFreshnessMs(response, maximum, now);
}
