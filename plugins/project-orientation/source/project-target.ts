import { stat } from "node:fs/promises";

import {
  ProjectInspectionError,
  throwIfProjectInspectionCancelled,
} from "./inspection-failure.js";

function isMissingProjectTarget(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Classify only the requested target lookup, never a disappearing child. */
export async function readProjectTargetInfo(
  absolutePath: string,
  signal?: AbortSignal,
) {
  try {
    return await stat(absolutePath);
  } catch (error) {
    throwIfProjectInspectionCancelled(signal);
    if (isMissingProjectTarget(error)) {
      throw new ProjectInspectionError(
        "project_target_not_found",
        "The requested project directory does not exist.",
      );
    }
    throw error;
  }
}
