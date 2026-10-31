export declare function createConversationFileFocus(options: {
  panel: HTMLElement;
  backdrop: HTMLElement;
  host: HTMLElement;
  closeButton: HTMLButtonElement;
  documentRoot: Document;
  viewport: Window;
  onClose: () => void;
  resolveReturnTarget?: (identity: DOMStringMap | null) => HTMLElement | null;
}): {
  show(opener?: HTMLElement, options?: { focusOnOpen?: boolean }): void;
  hide(restoreFocus: boolean): void;
};
