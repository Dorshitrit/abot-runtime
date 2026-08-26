import {
  buildDeterministicWorkspaceConcat,
  readWorkspaceMarkdownFiles,
} from "../../workspace/files.js";
import { getDefaultWorkspaceSourceDir } from "../config/layout.js";
import type { WorkspaceProvider } from "../ports.js";

export type SourceWorkspaceProviderOptions = {
  workspaceDir?: string;
};

export function createSourceWorkspaceProvider(
  options: SourceWorkspaceProviderOptions = {},
): WorkspaceProvider {
  const workspaceDir =
    options.workspaceDir ?? getDefaultWorkspaceSourceDir(process.cwd());

  async function loadWorkspaceSystemSummary(): Promise<string> {
    const files = await readWorkspaceMarkdownFiles(workspaceDir);
    return buildDeterministicWorkspaceConcat(files).trim();
  }

  return {
    getSystemSummary() {
      return loadWorkspaceSystemSummary();
    },
  };
}
