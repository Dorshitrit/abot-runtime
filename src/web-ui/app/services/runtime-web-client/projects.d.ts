import type { ProjectFolderPage, RuntimeProject } from "../../../../runtime/projects/contracts.js";
import type { SessionProject } from "../../../../sessions/project-binding.js";

export interface ProjectRequests {
  supportsProjects(): boolean;
  listProjects(environmentId?: string): Promise<{ projects: readonly RuntimeProject[] }>;
  browseProjectFolders(directory?: string, cursor?: string, environmentId?: string): Promise<ProjectFolderPage>;
  createProject(input: { name: string; directory: string }, environmentId?: string): Promise<{ project: RuntimeProject }>;
  createProjectSession(projectId: string, environmentId?: string): Promise<{
    sessionId: string;
    project: SessionProject;
  }>;
}

export declare function createProjectRequests(options: {
  requestApi: (url: string, options?: RequestInit) => Promise<unknown>;
  getEnvironmentId: () => string;
  getConfig: () => Record<string, unknown> | null;
}): ProjectRequests;
