import type {
  ComposerAttachment,
  ComposerAttachmentsState,
} from "./composer-attachments-controller.js";
import type {
  ComposerSubmitDom,
  ComposerSubmitState,
} from "./composer-submit-controller.js";

export interface ComposerWorkspaceDom extends ComposerSubmitDom {
  composerForm: HTMLElement;
  runtimeSetupGuide?: HTMLElement;
  [name: string]: unknown;
}

export type HomeComposerState = ComposerAttachmentsState &
  ComposerSubmitState & {
    environmentId: string;
    text: string;
  };

export interface HomeComposerDraft {
  sessionId: string;
  environmentId: string;
  text: string;
  attachments: ComposerAttachment[];
}

export interface ComposerWorkspaceController<T extends ComposerWorkspaceDom = ComposerWorkspaceDom> {
  chatDom: Omit<T, "composerInput"> & ComposerSubmitDom;
  homeDom: Omit<T, "composerInput"> & ComposerSubmitDom;
  homeState: HomeComposerState;
  setWorkspace(workspace: string): void;
  isHome(): boolean;
  isChatVisible(): boolean;
  composerSessionId(): string;
  ensureHomeSession(): string;
  resetHomeDraft(): void;
  takeHomeDraft(text: string): HomeComposerDraft;
  restoreHomeDraft(draft: HomeComposerDraft): void;
  syncChatDraft(): void;
}

export declare function createComposerWorkspaceController<T extends ComposerWorkspaceDom>(
  options: {
    state: Pick<ComposerSubmitState, "currentSessionId">;
    dom: T;
    homeComposerHost: HTMLElement;
    homeSetupHost?: HTMLElement;
    selectedEnvironmentId(): string;
    createSessionId?(): string;
  },
): ComposerWorkspaceController<T>;
