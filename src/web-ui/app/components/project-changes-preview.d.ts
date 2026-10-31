import type { ProjectChanges } from "../services/runtime-web-client/project-changes.js";
import type { ProjectChangesViewState } from "../controllers/project-changes-controller.js";
export declare function projectChangesCountLabel(changes: ProjectChanges): string;
export declare function createProjectChangesPreview(options: {
  host: HTMLElement; documentRoot?: Document; viewport?: Window;
  onClose(): void; onRefresh(): void | Promise<void>; onSelect(id: string): void | Promise<void>;
}): { render(state: ProjectChangesViewState): void; panel: HTMLElement };
