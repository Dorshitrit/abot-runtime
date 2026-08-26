export type LocalSearchErrorCode =
  | "local_search_root_not_found"
  | "local_search_target_invalid"
  | "local_search_result_encoding_unsupported"
  | "local_search_result_invalid"
  | "local_search_path_roundtrip_unsafe"
  | "local_search_failed";

export class LocalSearchError extends Error {
  readonly code: LocalSearchErrorCode;

  constructor(code: LocalSearchErrorCode, message: string) {
    super(message);
    this.name = "LocalSearchError";
    this.code = code;
  }
}

export function isLocalSearchError(error: unknown): error is LocalSearchError {
  return error instanceof LocalSearchError;
}
