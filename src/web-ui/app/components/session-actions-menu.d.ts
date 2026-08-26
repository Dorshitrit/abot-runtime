export function nextSessionActionIndex(
  current: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  length: number,
): number;

export function createSessionActionsMenu(
  options: Readonly<{
    container: HTMLElement;
    documentRoot?: Document;
    viewport?: Window;
  }>,
): Readonly<{
  bind: () => void;
  close: (options?: Readonly<{ restoreFocus?: boolean }>) => void;
  reset: () => void;
}>;
