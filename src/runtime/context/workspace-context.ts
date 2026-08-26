import { readFile, stat } from "node:fs/promises";

import type { CompiledWorkspaceSummary } from "../../workspace/types.js";
import { getDefaultWorkspaceSummaryPath } from "../config/layout.js";

export type WorkspaceContextProviderOptions = {
  compiledPath?: string;
};

export type WorkspaceContextProvider = {
  getWorkspaceSystemSummary: () => Promise<string>;
};

export function createWorkspaceContextProvider(
  options: WorkspaceContextProviderOptions = {},
): WorkspaceContextProvider {
  const compiledPath =
    options.compiledPath ?? getDefaultWorkspaceSummaryPath(process.cwd());
  let cachedSummary:
    | {
        mtimeMs: number;
        size: number;
        summary: string;
      }
    | null = null;

  async function loadWorkspaceSystemSummary(): Promise<string> {
    try {
      const fileStat = await stat(compiledPath);
      if (
        cachedSummary &&
        cachedSummary.mtimeMs === fileStat.mtimeMs &&
        cachedSummary.size === fileStat.size
      ) {
        return cachedSummary.summary;
      }
      const raw = await readFile(compiledPath, "utf-8");
      const parsed = JSON.parse(raw) as CompiledWorkspaceSummary;
      if (parsed && typeof parsed.summary === "string") {
        const summary = parsed.summary.trim();
        cachedSummary = {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          summary,
        };
        return summary;
      }
      cachedSummary = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        summary: "",
      };
      return "";
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        cachedSummary = null;
        return "";
      }
      throw error;
    }
  }

  return {
    getWorkspaceSystemSummary() {
      return loadWorkspaceSystemSummary();
    },
  };
}

const defaultWorkspaceContextProvider = createWorkspaceContextProvider();

export function getWorkspaceSystemSummary(): Promise<string> {
  return defaultWorkspaceContextProvider.getWorkspaceSystemSummary();
}
