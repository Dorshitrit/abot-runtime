import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionProject } from "../../sessions/project-binding.js";
import { copySessionProject } from "../../sessions/project-binding.js";
import type { RuntimeEnvironmentRegistry } from "../local-runtime/environment-registry.js";
import { ProjectChangesError } from "./contracts.js";

export type ProjectChangesEnvironments = Pick<RuntimeEnvironmentRegistry, "environmentConfig" | "setupRequirement" | "get">;
export type ProjectChangesAuthority = {
  directory: string;
  project: SessionProject;
  rootIdentity: string;
  assertCurrent(): Promise<void>;
};

export function readProjectChangesIdentifier(value: string | null): string {
  if (!value || value.length > 300 || /[\\/\x00-\x1f]/u.test(value))
    throw new ProjectChangesError("project_changes_reference_invalid", "Select a project conversation.");
  return value;
}

async function projectRootIdentity(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  if (canonical !== resolve(directory)) throw new ProjectChangesError("project_changes_stale", "The project directory changed.", 409);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new ProjectChangesError("project_changes_unavailable", "The project directory is unavailable.", 404);
  return JSON.stringify([canonical, String(info.dev), String(info.ino), String(info.birthtimeNs)]);
}

export async function authorizeProjectChanges(
  environments: ProjectChangesEnvironments, defaultEnvironment: string, environmentId: string, sessionId: string,
): Promise<ProjectChangesAuthority | null> {
  const isAvailable = () => {
    const configured = environments.environmentConfig();
    return (configured ? configured.environments.some((entry) => entry.id === environmentId) : environmentId === defaultEnvironment)
      && !environments.setupRequirement(environmentId);
  };
  if (!isAvailable())
    throw new ProjectChangesError("project_changes_unavailable", "This environment is unavailable.", 404);
  const environment = environments.get(environmentId);
  const session = await environment.services.sessions.getSessionById(sessionId);
  if (!session) throw new ProjectChangesError("project_changes_unavailable", "This conversation is unavailable.", 404);
  if (!session.project) return null;
  const project = copySessionProject(session.project);
  const rootIdentity = await projectRootIdentity(project.directory);
  return {
    directory: project.directory, project, rootIdentity,
    async assertCurrent() {
      if (!isAvailable() || environments.get(environmentId) !== environment)
        throw new ProjectChangesError("project_changes_stale", "The environment changed. Refresh project changes.", 409);
      const current = await environment.services.sessions.getSessionById(sessionId);
      if (current?.project?.id !== project.id || current.project.directory !== project.directory)
        throw new ProjectChangesError("project_changes_stale", "The conversation project changed.", 409);
      if (await projectRootIdentity(project.directory) !== rootIdentity)
        throw new ProjectChangesError("project_changes_stale", "The project directory changed.", 409);
      if (!isAvailable() || environments.get(environmentId) !== environment)
        throw new ProjectChangesError("project_changes_stale", "The environment changed. Refresh project changes.", 409);
    },
  };
}
