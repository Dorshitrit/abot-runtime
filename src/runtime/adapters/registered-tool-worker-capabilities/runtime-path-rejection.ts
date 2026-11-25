import type { RuntimeToolPathErrorCode } from "../../../capabilities/tool-types.js";
import { RuntimeToolPathError } from "../../capabilities/runtime-target-path.js";
import { payloadRejection } from "./payload-rejection.js";

// Only runtime-owned, enumerated path reasons may become model-visible evidence.
// Exception messages can contain private paths or untrusted text and are never used.
const PATH_REJECTION_MESSAGES = Object.freeze({
  runtime_tool_path_required: "The tool requires a target path.",
  runtime_tool_path_null_byte:
    "The target path contains an invalid null character.",
  runtime_tool_path_namespace_invalid:
    "The target path uses an unsupported path namespace.",
  runtime_tool_path_location_required:
    "The tool requires an explicit target location.",
  runtime_tool_path_root_unavailable:
    "The configured tool root is unavailable.",
  runtime_tool_path_workspace_unavailable:
    "The configured workspace is unavailable.",
  runtime_tool_path_outside_configured_roots:
    "The target path is outside the configured tool roots.",
  runtime_tool_path_symlink_escape:
    "The target path resolves outside its allowed root through a symbolic link.",
  runtime_tool_path_canonicalization_failed:
    "The target path could not be resolved safely.",
  runtime_tool_path_traversal: "The target path contains disallowed traversal.",
  runtime_tool_path_outside_working_directory:
    "The target path is outside the assigned working directory.",
} satisfies Record<RuntimeToolPathErrorCode, string>);

/** Call only from preparation, before the external tool can execute. */
export function runtimePathRejection(
  error: unknown,
): ReturnType<typeof payloadRejection> | undefined {
  if (!isKnownRuntimePathRejection(error)) return undefined;
  return payloadRejection(
    error.code,
    `${runtimePathRejectionMessage(error)} No external execution occurred.`,
  );
}

function runtimePathRejectionMessage(error: RuntimeToolPathError): string {
  if (error.filesystemFailure === "access_denied")
    return "The target path could not be resolved because filesystem access was denied.";
  return PATH_REJECTION_MESSAGES[error.code];
}

function isKnownRuntimePathRejection(
  error: unknown,
): error is RuntimeToolPathError {
  if (!(error instanceof RuntimeToolPathError)) return false;
  if (typeof error.code !== "string") return false;
  return Object.hasOwn(PATH_REJECTION_MESSAGES, error.code);
}
