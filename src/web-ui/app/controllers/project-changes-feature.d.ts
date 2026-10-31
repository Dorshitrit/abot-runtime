import type { CreateProjectFileChanges } from "./project-file-changes-feature.js";
import type { ProjectChangesClient } from "../services/runtime-web-client/project-changes.js";
import type { ProjectChangesScope } from "./project-changes-controller.js";
type ConversationMessage = { id?: string | number; requestId?: string; [key: string]: unknown };
type ProjectChangesRenderInput = {
  messages: ConversationMessage[]; isLatestWindow: boolean;
  getActivityForMessage?(message: ConversationMessage): { events?: Record<string, unknown>[] };
};
export declare function createProjectChangesFeature(options: {
  client?: ProjectChangesClient; getScope(): ProjectChangesScope; scrollRoot: HTMLElement;
  documentRoot?: Document; viewport?: Window; onBeforeOpen?(): void; canAutoOpen?(): boolean;
}): {
  sync(input: ProjectChangesRenderInput): void; createFileNode: CreateProjectFileChanges; finishRender(): void; activateVisible(): void;
  close(): void; reset(): void; setWorkspace(workspace: string): void;
};
