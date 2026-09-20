import type { ProjectRequests } from "../services/runtime-web-client/projects.js";
import type { ProjectFolderPage, RuntimeProject } from "../../../runtime/projects/contracts.js";

export type ProjectCreationDraft = {
  name: string;
  directory: string;
  pickerOpen: boolean;
  listing: ProjectFolderPage | null;
  loading: boolean;
  saving: boolean;
  error: string;
};

export type ProjectsControllerState = {
  projects: readonly RuntimeProject[];
  loading: boolean;
  error: string;
  draft: ProjectCreationDraft | null;
  busyProjectId: string;
};

export declare function createProjectsController(options: {
  client: ProjectRequests;
  getEnvironmentId: () => string;
  getConversationRevision: () => string | number;
  prepareConversation: () => boolean;
  openSession: (sessionId: string) => Promise<unknown>;
  loadSessions: () => Promise<unknown>;
  onChange: (state: ProjectsControllerState) => void;
  notify: (message: string, tone: "failed") => void;
  onSessionCreated?: (sessionId: string) => void;
}): {
  snapshot(): ProjectsControllerState;
  load(): Promise<void>;
  environmentChanged(): Promise<void>;
  openCreate(): void;
  closeCreate(): boolean;
  updateDraft(field: string, value: string): void;
  openFolderPicker(): Promise<void>;
  cancelFolderPicker(): void;
  selectFolder(): void;
  browse(directory?: string, cursor?: string): Promise<void>;
  create(): Promise<void>;
  newConversation(projectId: string): Promise<void>;
};
