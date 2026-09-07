export type PublicHttpErrorCode =
  | "web_request_aborted"
  | "web_request_timed_out"
  | "web_request_capacity_exceeded"
  | "web_target_invalid"
  | "web_target_not_public"
  | "web_target_unresolvable"
  | "web_redirect_invalid"
  | "web_redirect_limit_exceeded"
  | "web_response_invalid";

export class PublicHttpError<
  Code extends string = PublicHttpErrorCode,
> extends Error {
  readonly code: Code;

  constructor(code: Code, message: string) {
    super(message);
    this.name = "PublicHttpError";
    this.code = code;
  }
}

export function isPublicHttpError(error: unknown): error is PublicHttpError {
  return error instanceof PublicHttpError;
}
