import {
  PublicHttpError,
  isPublicHttpError,
  type PublicHttpErrorCode,
} from "../../../src/shared/public-http/errors.js";

export type WebPluginErrorCode =
  | PublicHttpErrorCode
  | "web_response_unsupported"
  | "web_fetch_http_error"
  | "web_search_api_key_missing"
  | "web_search_authentication_failed"
  | "web_search_rate_limited"
  | "web_search_upstream_failed"
  | "web_search_response_invalid"
  | "web_search_budget_exhausted"
  | "web_search_source_blocked"
  | "web_search_sources_unavailable"
  | "web_search_configuration_invalid";

export class WebPluginError extends PublicHttpError<WebPluginErrorCode> {
  readonly code: WebPluginErrorCode;

  constructor(code: WebPluginErrorCode, message: string) {
    super(code, message);
    this.name = "WebPluginError";
    this.code = code;
  }
}

export function isWebPluginError(error: unknown): error is WebPluginError {
  return error instanceof WebPluginError;
}

export function rethrowWebPluginError(error: unknown): never {
  if (error instanceof WebPluginError) throw error;
  if (isPublicHttpError(error)) {
    throw new WebPluginError(error.code, error.message);
  }
  throw error;
}
