export type WebPluginErrorCode =
  | "web_request_aborted"
  | "web_request_timed_out"
  | "web_request_capacity_exceeded"
  | "web_target_invalid"
  | "web_target_not_public"
  | "web_target_unresolvable"
  | "web_redirect_invalid"
  | "web_redirect_limit_exceeded"
  | "web_response_unsupported"
  | "web_response_invalid"
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

export class WebPluginError extends Error {
  readonly code: WebPluginErrorCode;

  constructor(code: WebPluginErrorCode, message: string) {
    super(message);
    this.name = "WebPluginError";
    this.code = code;
  }
}

export function isWebPluginError(error: unknown): error is WebPluginError {
  return error instanceof WebPluginError;
}
