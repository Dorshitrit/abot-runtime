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
  deletedProjectIds: readonly string[];
  loading: boolean;
  error: string;
  draft: ProjectCreationDraft | null;
  busyProjectId: string;
};

export declare function createProjectsController(options: {
  client: ProjectRequests;
  getEnvironmentId: () => string;
  isRuntimeReady?: () => boolean;
  getConversationRevision: () => string | number;
  prepareConversation: () => boolean | Promise<boolean>;
  openSession: (sessionId: string) => Promise<unknown>;
  loadSessions: () => Promise<unknown>;
  onChange: (state: ProjectsControllerState) => void;
  notify: (message: string, tone: "failed") => void;
  onSessionCreated?: (sessionId: string) => void;
  confirmAction?: (message: string) => boolean | Promise<boolean>;
}): {
  snapshot(): ProjectsControllerState;
  load(): Promise<void>;
  environmentChanged(): Promise<void>;
  runtimeAvailabilityChanged(): Promise<void>;
  openCreate(): void;
  closeCreate(): boolean;
  updateDraft(field: string, value: string): void;
  openFolderPicker(): Promise<void>;
  cancelFolderPicker(): void;
  selectFolder(): void;
  browse(directory?: string, cursor?: string): Promise<void>;
  create(): Promise<void>;
  newConversation(projectId: string): Promise<void>;
  deleteProject(projectId: string, projectName?: string): Promise<boolean>;
  getDeletedProjectIds(): readonly string[];
};
