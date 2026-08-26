export function createModelSelector(
  options: Readonly<{
    select: HTMLSelectElement;
    button: HTMLButtonElement;
    valueLabel: HTMLElement;
    menu: HTMLElement;
    documentRoot?: Document;
    viewport?: Window;
    onOpen?: () => void;
  }>,
): Readonly<{
  bind: () => void;
  close: () => void;
  sync: () => void;
}>;
