import { vi } from "vitest";
import { createProjectsController } from "../../../web-ui/app/controllers/projects-controller.js";
import type { ProjectRequests } from "../../../web-ui/app/services/runtime-web-client/projects.js";
import type { ProjectFolderPage, RuntimeProject } from "../../projects/contracts.js";

export function deferredProjectResult<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

export function project(id = "project-one"): RuntimeProject {
  return { id, name: id, directory: `/work/${id}`, createdAt: "2026-09-17T00:00:00Z" };
}

export function folderPage(directory = "/work"): ProjectFolderPage {
  return {
    directory, parent: "/", entries: [], roots: [], nextCursor: null,
    hostPlatform: "linux",
  };
}

export function projectClient() {
  return {
    supportsProjects: vi.fn<ProjectRequests["supportsProjects"]>(() => true),
    listProjects: vi.fn<ProjectRequests["listProjects"]>(async () => ({ projects: [] })),
    browseProjectFolders: vi.fn<ProjectRequests["browseProjectFolders"]>(async () => folderPage()),
    createProject: vi.fn<ProjectRequests["createProject"]>(async () => ({ project: project() })),
    createProjectSession: vi.fn<ProjectRequests["createProjectSession"]>(async () => ({ sessionId: "created-session", project: project() })),
  };
}

export function projectsControllerFixture() {
  let environmentId = "prod";
  let conversationRevision = "existing:1";
  const client = projectClient();
  const dependencies = {
    client,
    getEnvironmentId: () => environmentId,
    getConversationRevision: () => conversationRevision,
    prepareConversation: vi.fn(() => true),
    openSession: vi.fn(async (_sessionId: string) => {}),
    loadSessions: vi.fn(async () => {}),
    onChange: vi.fn(), notify: vi.fn(), onSessionCreated: vi.fn(),
  };
  const controller = createProjectsController(dependencies);
  return {
    ...dependencies, controller,
    setEnvironment: (value: string) => { environmentId = value; },
    navigateConversation: (value: string) => { conversationRevision = value; },
  };
}
