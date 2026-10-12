import {
  failureResult,
  type BoundedRegularFileReadFailure,
} from "../../../src/plugin-sdk/index.js";

export function jsonReadFailure(
  file: BoundedRegularFileReadFailure,
  maxBytes: number,
) {
  switch (file.reason) {
    case "not_regular_file":
      return failureResult({
        errorCode: "json_target_not_file",
        message: "The requested JSON target is not a regular file.",
      });
    case "too_large":
      return failureResult({
        errorCode: "json_file_too_large",
        message:
          "The requested file exceeds the " +
          maxBytes +
          "-byte JSON inspection limit.",
      });
    case "outside_root":
      return failureResult({
        errorCode: "json_outside_root",
        message:
          "The requested file resolves outside its authorized root. Do not retry this target or bypass the path restriction.",
      });
    case "safe_open_unsupported":
      return failureResult({
        errorCode: "json_safe_read_unavailable",
        message:
          "Safe file reading is unavailable on this system. On Windows, computer policy may block the required PowerShell/C# helper. Do not retry or bypass this restriction with another tool; ask the user to check the system requirements or contact their administrator.",
      });
    case "changed_during_read":
      return failureResult({
        errorCode: "json_file_changed",
        message: "The requested JSON file changed while it was read.",
      });
  }
}
