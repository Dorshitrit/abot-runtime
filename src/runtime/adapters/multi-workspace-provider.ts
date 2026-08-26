import type { WorkspaceProvider } from "../ports.js";

export type MultiWorkspaceProviderOptions = {
  workspaces: Record<string, WorkspaceProvider>;
  defaultWorkspace: string;
  resolveWorkspace?: () => string | undefined | null;
};

export function createMultiWorkspaceProvider(
  options: MultiWorkspaceProviderOptions,
): WorkspaceProvider {
  const workspaces = { ...options.workspaces };
  const defaultProvider = workspaces[options.defaultWorkspace];
  if (!defaultProvider) {
    throw new Error(
      `default workspace provider not found: ${options.defaultWorkspace}`,
    );
  }

  return {
    getSystemSummary() {
      const workspaceKey =
        options.resolveWorkspace?.() ?? options.defaultWorkspace;
      const provider = workspaces[workspaceKey] ?? defaultProvider;
      return provider.getSystemSummary();
    },
  };
}
