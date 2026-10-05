import { isAbsolute } from "node:path";
import type { AutomationGraphIssue } from "./graph-validation.js";

/** The override replaces the Runtime work root; relative paths belong to tool inputs. */
export function validateAutomationWorkingDirectory(directory: string | undefined): AutomationGraphIssue | null {
  if (directory === undefined) return null;
  if (isAbsolute(directory)) return null;
  return {
    code: "automation_working_directory_invalid",
    path: "workingDirectory",
    message: "Use an absolute path on the Runtime host, or leave the working directory empty to use the configured default.",
  };
}
