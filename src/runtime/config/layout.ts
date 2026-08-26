import { join } from "node:path";

export const DEFAULT_RUNTIME_STATE_DIR = ".runtime";
export const DEFAULT_AGENT_WORK_DIR = "agent-work";
export const DEFAULT_WORKSPACE_SOURCE_DIR = "workspace";
export const RUNTIME_SHARED_DIR_NAME = "shared";
export const RUNTIME_COMPILED_DIR_NAME = "compiled";
export const RUNTIME_SESSIONS_DIR_NAME = "sessions";
export const RUNTIME_ATTACHMENTS_DIR_NAME = "attachments";
export const RUNTIME_LOGS_DIR_NAME = "logs";
export const DEFAULT_RUNTIME_SHARED_DIR = join(
  DEFAULT_RUNTIME_STATE_DIR,
  RUNTIME_SHARED_DIR_NAME,
);
export const DEFAULT_RUNTIME_COMPILED_DIR = join(
  DEFAULT_RUNTIME_STATE_DIR,
  RUNTIME_COMPILED_DIR_NAME,
);
export const DEFAULT_RUNTIME_SESSIONS_DIR = join(
  DEFAULT_RUNTIME_STATE_DIR,
  RUNTIME_SESSIONS_DIR_NAME,
);
export const DEFAULT_RUNTIME_ATTACHMENTS_DIR = join(
  DEFAULT_RUNTIME_STATE_DIR,
  RUNTIME_ATTACHMENTS_DIR_NAME,
);
export const DEFAULT_RUNTIME_TRACE_FILE = join(
  DEFAULT_RUNTIME_STATE_DIR,
  RUNTIME_LOGS_DIR_NAME,
  "runtime-debug.jsonl",
);

export const WORKSPACE_SUMMARY_FILE = "workspace-summary.json";

export function getDefaultWorkspaceSummaryPath(rootDir: string): string {
  return join(rootDir, DEFAULT_RUNTIME_COMPILED_DIR, WORKSPACE_SUMMARY_FILE);
}

export function getDefaultWorkspaceSourceDir(rootDir: string): string {
  return join(rootDir, DEFAULT_WORKSPACE_SOURCE_DIR);
}

export function getDefaultSessionsDir(rootDir: string): string {
  return join(rootDir, DEFAULT_RUNTIME_SESSIONS_DIR);
}
