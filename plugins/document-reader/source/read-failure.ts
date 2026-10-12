import type { BoundedRegularFileReadFailure } from "../../../src/plugin-sdk/index.js";
import { failDocument } from "./errors.js";

export function failDocumentRead(
  file: BoundedRegularFileReadFailure,
  maxBytes: number,
): never {
  switch (file.reason) {
    case "not_regular_file":
      return failDocument(
        "document_target_not_file",
        "The requested document is not a regular file.",
      );
    case "too_large":
      return failDocument(
        "document_file_too_large",
        "The requested document exceeds the " +
          maxBytes +
          "-byte parsing limit.",
      );
    case "outside_root":
      return failDocument(
        "document_outside_root",
        "The requested document resolves outside its authorized root. Do not retry this target or bypass the path restriction.",
      );
    case "safe_open_unsupported":
      return failDocument(
        "document_safe_read_unavailable",
        "Safe file reading is unavailable on this system. On Windows, computer policy may block the required PowerShell/C# helper. Do not retry or bypass this restriction with another tool; ask the user to check the system requirements or contact their administrator.",
      );
    case "changed_during_read":
      return failDocument(
        "document_changed_during_read",
        "The requested document changed while it was being read.",
      );
  }
}
