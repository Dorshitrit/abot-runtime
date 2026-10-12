import {
  failureFromError,
  failureResult,
  type BoundedRegularFileReadFailure,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

class ProjectInspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectInspectionError";
  }
}

export function throwIfProjectInspectionCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isProjectInspectionCancelled(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}

export function failProjectManifestRead(
  file: BoundedRegularFileReadFailure,
): never {
  if (file.reason === "safe_open_unsupported") {
    throw new ProjectInspectionError(
      "project_safe_read_unavailable",
      "Safe project manifest reading is unavailable on this system. On Windows, computer policy may block the required PowerShell/C# helper. Do not retry or bypass this restriction with another tool; ask the user to check system requirements or contact their administrator.",
    );
  }
  if (file.reason === "outside_root") {
    throw new ProjectInspectionError(
      "project_outside_root",
      "The project manifest resolves outside its authorized root. Do not retry this target or bypass the path restriction.",
    );
  }
  // Keep the pre-existing generic failure for a manifest that changes or stops being a file.
  throw new Error("Project manifest changed while it was being read.");
}

export function projectInspectionFailure(
  error: unknown,
  signal?: AbortSignal,
): ToolImplementationOutput {
  if (isProjectInspectionCancelled(error, signal)) {
    return failureResult({
      errorCode: "project_inspection_cancelled",
      message: "Project inspection was cancelled.",
      interruption: "aborted",
    });
  }
  if (error instanceof ProjectInspectionError) {
    return failureResult({ errorCode: error.code, message: error.message });
  }
  return failureFromError(error, {
    fallbackCode: "project_orientation_failed",
    fallbackMessage: "Project orientation failed.",
    operation: "inspect_project",
  });
}
