import type { SessionProject } from "../../sessions/project-binding.js";

export type RuntimeProject = SessionProject & Readonly<{ createdAt: string }>;
export type ProjectFolder = Readonly<{ name: string; path: string }>;
export type ProjectFolderPage = Readonly<{
  directory: string;
  parent: string | null;
  entries: readonly ProjectFolder[];
  nextCursor: string | null;
  roots: readonly Readonly<{ label: string; path: string }>[];
  hostPlatform: NodeJS.Platform;
}>;
export type RuntimeProjectService = Readonly<{
  list: () => Promise<readonly RuntimeProject[]>;
  get: (id: string) => Promise<RuntimeProject | null>;
  create: (input: {
    name?: string;
    directory: string;
  }) => Promise<RuntimeProject>;
  browseFolders: (input?: {
    path?: string;
    cursor?: string;
  }) => Promise<ProjectFolderPage>;
  createSession: (
    projectId: string,
  ) => Promise<{ sessionId: string; project: SessionProject }>;
}>;

export class ProjectOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProjectOperationError";
  }
}
