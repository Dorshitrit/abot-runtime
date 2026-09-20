import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RuntimeConfig, SessionStore } from "../ports.js";
import { copySessionProject } from "../../sessions/project-binding.js";
import { FileProjectRepository } from "./repository.js";
import {
  browseProjectFolders,
  projectDisplayName,
  resolveProjectDirectory,
} from "./folders.js";
import {
  ProjectOperationError,
  type RuntimeProjectService,
} from "./contracts.js";

export function createRuntimeProjectService(
  config: RuntimeConfig,
  sessions: Pick<SessionStore, "getOrCreateSession">,
): RuntimeProjectService {
  const repository = new FileProjectRepository(
    join(config.paths.runtimeDir, "projects", "registry.json"),
  );
  const get = async (id: string) =>
    (await repository.list()).find((project) => project.id === id) ?? null;
  return Object.freeze({
    list: () => repository.list(),
    get,
    async create(input: { name?: string; directory: string }) {
      const directory = await resolveProjectDirectory(input.directory);
      return repository.create({
        id: randomUUID(),
        name: projectDisplayName(input.name, directory),
        directory,
        createdAt: new Date().toISOString(),
      });
    },
    browseFolders: (input?: { path?: string; cursor?: string }) =>
      browseProjectFolders(config.paths.agentWorkDir, input),
    async createSession(projectId: string) {
      const record = await get(projectId);
      if (!record)
        throw new ProjectOperationError(
          "project_not_found",
          "This project no longer exists.",
          404,
        );
      await resolveProjectDirectory(record.directory);
      const project = copySessionProject(record);
      const sessionId = randomUUID();
      await sessions.getOrCreateSession(sessionId, { project });
      return { sessionId, project };
    },
  });
}
