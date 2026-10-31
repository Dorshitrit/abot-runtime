import type { ProjectChangesClient, ProjectChanges, ProjectChangeDiff } from "../services/runtime-web-client/project-changes.js";
export type ProjectChangesScope = { environmentId?: string; sessionId?: string; activeRequestId?: string };
export type ProjectChangesViewState = {
  anchorId: string; open: boolean; loading: boolean; changes: ProjectChanges | null; error: string;
  selectedId: string; file: ProjectChangeDiff | null; fileLoading: boolean; fileError: string;
  opener: HTMLElement | null; restoreFocus: boolean;
};
export declare function createProjectChangesController(options: {
  client: Pick<ProjectChangesClient, "supportsProjectChanges" | "loadProjectChanges" | "loadProjectChangeDiff">; getScope(): ProjectChangesScope;
  render(state: ProjectChangesViewState): void; AbortControllerImpl?: typeof AbortController;
}): {
  sync(input?: { anchorId?: string; isLatestWindow?: boolean }): void;
  open(opener?: HTMLElement): void; close(options?: { restoreFocus?: boolean }): void;
  refresh(): Promise<void>; selectFile(id: string): Promise<void>; reset(): void;
};
