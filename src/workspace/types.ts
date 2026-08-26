export type WorkspaceSourceFile = {
  path: string;
  content: string;
};

export type CompiledWorkspaceSummary = {
  sourceHash: string;
  generatedAt: string;
  files: string[];
  summary: string;
};
