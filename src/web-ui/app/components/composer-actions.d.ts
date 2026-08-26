export type ComposerAction = "send" | "steer" | "send_next";

export declare function createComposerActions(options: {
  dom: {
    composerForm: HTMLFormElement;
    composerSubmitControl: HTMLElement;
    sendButton: HTMLButtonElement;
    sendButtonLabel: HTMLElement;
    sendNextMenuButton: HTMLButtonElement;
    sendNextMenu: HTMLElement;
    sendNextButton: HTMLButtonElement;
  };
  onSendNext: () => void;
  documentRoot?: Document;
}): Readonly<{
  bind(): void;
  closeMenu(options?: { restoreFocus?: boolean }): boolean;
  primaryAction(): ComposerAction;
  render(options: {
    activeRequestId: unknown;
    attachmentCount?: number;
    busy?: boolean;
    disabled?: boolean;
    queuedCount?: number;
  }): void;
}>;
