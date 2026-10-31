import type { ComposerDraft, ComposerDrafts, ComposerScope } from "./composer-drafts.js";
import type { ComposerDraftInput, ComposerDraftView, ComposerInputSurface } from "./composer-draft-view.js";

export interface ComposerWorkspaceDom {
  composerInput: ComposerDraftInput;
  composerForm: HTMLElement;
  runtimeSetupGuide?: HTMLElement;
}

export interface ComposerWorkspaceController<T extends ComposerWorkspaceDom = ComposerWorkspaceDom> {
  drafts: ComposerDrafts;
  chatDraft(): ComposerDraft;
  homeDraft(): ComposerDraft;
  chatView: ComposerDraftView;
  homeView: ComposerDraftView;
  chatDom: Omit<T, "composerInput"> & { composerInput: ComposerInputSurface };
  homeDom: Omit<T, "composerInput"> & { composerInput: ComposerInputSurface };
  setWorkspace(workspace: string): void;
  isHome(): boolean;
  isChatVisible(): boolean;
  composerSessionId(): string;
  ensureHomeSession(): string;
  finishHomeActivation(scope: ComposerScope): void;
  syncChatDraft(): void;
  resetSessionDraft(scope: ComposerScope, deleted: boolean): void;
  preserveResetDraft(scope: ComposerScope): string | undefined;
  restoreResetDraft(savedSessionId: string): boolean;
}

export declare function createComposerWorkspaceController<T extends ComposerWorkspaceDom>(options: {
  state: { currentSessionId: string };
  dom: T;
  homeComposerHost: HTMLElement;
  homeSetupHost?: HTMLElement;
  selectedEnvironmentId(): string;
  createSessionId?(): string;
  onSessionCreated?(sessionId: string): void;
  drafts?: ComposerDrafts;
}): ComposerWorkspaceController<T>;
