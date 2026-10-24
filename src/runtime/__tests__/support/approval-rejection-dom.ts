import { ContextElement } from "./composer-context-window-dom.js";

export class ApprovalRejectionDocument {
  activeElement: ApprovalRejectionElement | null = null;
  createElement = (tag: string) => new ApprovalRejectionElement(tag, this);
}

export class ApprovalRejectionElement extends ContextElement {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "none";
  scrollTop = 0;

  constructor(
    tag: string,
    readonly ownerDocument: ApprovalRejectionDocument,
  ) {
    super(tag);
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start: number, end: number, direction = "none") {
    if (this.tagName !== "textarea")
      throw new Error("Selection requires a textarea");
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  querySelectorAll(selector: string): ApprovalRejectionElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.children.flatMap((child) => [
      ...(selectors.some((part) => child.matches(part))
        ? [child as ApprovalRejectionElement]
        : []),
      ...(child as ApprovalRejectionElement).querySelectorAll(selector),
    ]);
  }

  override replaceChildren(...children: ContextElement[]) {
    if (this.contains(this.ownerDocument.activeElement))
      this.ownerDocument.activeElement = null;
    super.replaceChildren(...children);
  }

  removeChild(child: ContextElement) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("Missing child");
    if (child.contains(this.ownerDocument.activeElement))
      this.ownerDocument.activeElement = null;
    this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  insertBefore(child: ContextElement, reference: ContextElement | null) {
    if (child.parentElement)
      (child.parentElement as ApprovalRejectionElement).removeChild(child);
    if (!reference) return this.appendChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error("Missing reference");
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }
}

export function rejectionButton(root: ApprovalRejectionElement, text: string) {
  const button = root
    .querySelectorAll("button")
    .find((node) => node.textContent === text);
  if (!button) throw new Error("Missing button: " + text);
  return button;
}

export function rejectionInput(root: ApprovalRejectionElement) {
  return root.querySelector("textarea") as ApprovalRejectionElement;
}
