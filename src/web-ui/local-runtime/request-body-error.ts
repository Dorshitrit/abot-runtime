const REQUEST_BODY_ERROR_MESSAGES = {
  invalid_json: "Request body must contain valid JSON.",
  json_object_required: "Request body must be a JSON object.",
} as const;

/** A client syntax/shape failure, distinct from unexpected backend exceptions. */
export class RequestBodyInputError extends Error {
  readonly statusCode = 400;

  constructor(readonly code: keyof typeof REQUEST_BODY_ERROR_MESSAGES) {
    super(REQUEST_BODY_ERROR_MESSAGES[code]);
    this.name = "RequestBodyInputError";
  }
}
