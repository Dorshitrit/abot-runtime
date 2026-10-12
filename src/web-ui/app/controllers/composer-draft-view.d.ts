import type { ComposerDraft } from "./composer-drafts.js";

export interface ComposerInputSurface {
  value: string;
  readonly style: { height: string };
  readonly scrollHeight: number;
  focus(): void;
}

export interface ComposerDraftInput extends ComposerInputSurface {
  addEventListener?(type: "input", listener: () => void): void;
}

export interface ComposerDraftView {
  surface: ComposerInputSurface;
  current(): ComposerDraft;
  display(): ComposerDraft;
  saveDisplayed(): void;
  refresh(draft: ComposerDraft): void;
  detach(): void;
}

export declare function createComposerDraftView(options: {
  input: ComposerDraftInput;
  getDraft(): ComposerDraft;
  isVisible?(): boolean;
}): ComposerDraftView;
