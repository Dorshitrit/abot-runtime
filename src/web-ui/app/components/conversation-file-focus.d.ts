export declare function createConversationFileFocus(options: {
  panel: HTMLElement;
  backdrop: HTMLElement;
  host: HTMLElement;
  closeButton: HTMLButtonElement;
  documentRoot: Document;
  viewport: Window;
  onClose: () => void;
}): {
  show(opener?: HTMLElement): void;
  hide(restoreFocus: boolean): void;
};
