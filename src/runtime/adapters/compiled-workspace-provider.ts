import { createWorkspaceContextProvider } from "../context/workspace-context.js";
import type { WorkspaceProvider } from "../ports.js";

export type CompiledWorkspaceProviderOptions = {
  compiledPath?: string;
};

export function createCompiledWorkspaceProvider(
  options: CompiledWorkspaceProviderOptions = {},
): WorkspaceProvider {
  const provider = createWorkspaceContextProvider(options);
  return {
    getSystemSummary: provider.getWorkspaceSystemSummary,
  };
}
