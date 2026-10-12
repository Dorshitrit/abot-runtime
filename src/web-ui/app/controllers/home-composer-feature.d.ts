import type { ComposerFeature, ComposerSurface, ComposerSurfaceDom } from "./composer-feature.js";
import type { ComposerWorkspaceController, ComposerWorkspaceDom } from "./composer-workspace-controller.js";
import type { ComposerUploadFile } from "./composer-attachments-controller.js";
import type { ComposerScope } from "./composer-drafts.js";
import type { ComposerSubmitController } from "./composer-submit-controller.js";

export interface HomeComposerFeature extends ComposerSurface {
  setWorkspace(destination: string): void;
  environmentChanged(): void;
  dispatch(): ReturnType<ComposerSubmitController["dispatch"]>;
  upload(file: ComposerUploadFile): Promise<void>;
}
export declare function createHomeComposerFeature<T extends ComposerWorkspaceDom & ComposerSurfaceDom>(options: {
  workspace: ComposerWorkspaceController<T>;
  composer: Pick<ComposerFeature, "createSurface">;
  selectedModelSupportsImageInput(): boolean;
  activateHomeSession(scope: ComposerScope): boolean | Promise<boolean>;
}): HomeComposerFeature;
