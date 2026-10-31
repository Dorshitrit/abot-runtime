import type { ConversationToolAction } from "../lib/tool-activity-model.js";
import type { ProjectChangesClient } from "../services/runtime-web-client/project-changes.js";
import type { ProjectChangesScope } from "./project-changes-controller.js";
export type ProjectFileChangesInput = {
  requestId: string; action: ConversationToolAction; details: HTMLDetailsElement;
  isCurrentAction(): boolean; excerpt?: HTMLElement | null;
};
export type CreateProjectFileChanges = (input: ProjectFileChangesInput) => HTMLElement | null;
export declare function createProjectFileChangesFeature(options: {
  client?: ProjectChangesClient; getScope(): ProjectChangesScope; documentRoot?: Document; AbortControllerImpl?: typeof AbortController;
}): { createNode: CreateProjectFileChanges; beginRender(): void; finishRender(): void; activateVisible(): void; setActive(active: boolean): void; reset(): void };
