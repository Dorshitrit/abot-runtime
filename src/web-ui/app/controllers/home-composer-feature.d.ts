import type {
  ComposerAttachmentsClient,
  ComposerAttachmentControlEvent,
  ComposerAttachmentsController,
  ComposerAttachmentsShell,
  ComposerUploadFile,
} from "./composer-attachments-controller.js";
import type {
  ComposerSubmissionBlock,
  ComposerSubmitActions,
  ComposerSubmitController,
} from "./composer-submit-controller.js";
import type {
  ComposerWorkspaceController,
  HomeComposerDraft,
} from "./composer-workspace-controller.js";

export declare function createHomeComposerFeature(options: {
  workspace: ComposerWorkspaceController;
  shell: ComposerAttachmentsShell;
  client: ComposerAttachmentsClient;
  composerActions: ComposerSubmitActions;
  selectedEnvironmentId(): string;
  selectedModelSupportsImageInput(): boolean;
  isComposerAvailable?(): boolean;
  getSubmissionBlock?(): ComposerSubmissionBlock | null;
  onSubmissionBlocked?(block: ComposerSubmissionBlock): void;
  onControlEvent(event: ComposerAttachmentControlEvent): void;
  onStateChange(): void;
  activateHomeSession(draft: HomeComposerDraft): boolean | void;
  sendMessage(text: string): Promise<void>;
}): {
  attachments: ComposerAttachmentsController;
  submit: ComposerSubmitController;
  setWorkspace(destination: string): void;
  environmentChanged(): void;
  dispatch(): void;
  upload(file: ComposerUploadFile): Promise<void>;
  render(): void;
};
