import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createConfirmationDialog, confirmDialog } from "../../web-ui/app/components/confirmation-dialog.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function harness() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.body = document.createElement("body");
  const trigger = document.createElement("button");
  Object.defineProperty(trigger, "isConnected", { get: () => document.body.contains(trigger) });
  document.body.append(trigger);
  trigger.focus();
  const confirmation = createConfirmationDialog({ documentRoot: document });
  const dialog = document.body.querySelector("dialog")!;
  return { document, trigger, confirmation, dialog,
    accept: dialog.querySelector("[data-confirmation-accept]")!,
    cancel: dialog.querySelector("[data-confirmation-cancel]")! };
}

afterEach(() => vi.unstubAllGlobals());

describe("application confirmation dialog", () => {
  test("waits for explicit acceptance, focuses Cancel and renders untrusted labels as text", async () => {
    const h = harness();
    const settled = vi.fn();
    const result = h.confirmation.confirm('<img src=x onerror="bad()">', {
      title: 'Delete <b>project</b>?', confirmLabel: 'Delete project', tone: 'danger',
    });
    void result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(h.document.activeElement).toBe(h.cancel);
    expect(h.dialog.querySelector("h2")!.textContent).toBe('Delete <b>project</b>?');
    expect(h.dialog.querySelector("img")).toBeNull();
    expect(h.dialog.querySelector(".confirmation-description")!.textContent).toContain('<img');
    expect(h.accept.textContent).toBe("Delete project");
    expect(h.dialog.dataset.tone).toBe("danger");
    h.accept.dispatch("click");
    expect(await result).toBe(true);
    expect(h.dialog.open).toBe(false);
    expect(h.document.activeElement).toBe(h.trigger);
  });

  test.each(["cancel-button", "close-button", "escape", "external-close", "destroy"])("%s never approves", async (action) => {
    const h = harness();
    const result = h.confirmation.confirm("Clear history?");
    if (action === "cancel-button") h.cancel.dispatch("click");
    if (action === "close-button") h.dialog.querySelector(".confirmation-close")!.dispatch("click");
    if (action === "escape") h.dialog.dispatch("cancel");
    if (action === "external-close") { h.dialog.close(); h.dialog.dispatch("close"); }
    if (action === "destroy") h.confirmation.destroy();
    expect(await result).toBe(false);
    expect(h.dialog.open).toBe(false);
  });

  test("Escape is consumed by the modal before underlying workspace shortcuts", async () => {
    const h = harness();
    const result = h.confirmation.confirm("Delete project?");
    const event = { key: "Escape", isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const handler of h.dialog.listeners.get("keydown")!) handler(event);
    expect(await result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  test("does not replace or queue a pending approval with a second target", async () => {
    const h = harness();
    const first = h.confirmation.confirm("Delete first?");
    expect(await h.confirmation.confirm("Delete second?")).toBe(false);
    expect(h.dialog.querySelector(".confirmation-description")!.textContent).toBe("Delete first?");
    h.accept.dispatch("click");
    expect(await first).toBe(true);
  });

  test("ignores delayed close events from an already settled request", async () => {
    const h = harness();
    const first = h.confirmation.confirm("First");
    h.accept.dispatch("click");
    expect(await first).toBe(true);
    const second = h.confirmation.confirm("Second");
    h.dialog.dispatch("close");
    expect(h.dialog.open).toBe(true);
    h.accept.dispatch("click");
    expect(await second).toBe(true);
  });

  test("does not refocus a removed trigger and fails closed if a modal cannot open", async () => {
    const h = harness();
    const first = h.confirmation.confirm("Delete");
    h.trigger.remove(); h.trigger.focus.mockClear();
    h.confirmation.cancel();
    expect(await first).toBe(false);
    expect(h.trigger.focus).not.toHaveBeenCalled();
    h.dialog.showModal = () => { throw new Error("Unavailable document"); };
    expect(await h.confirmation.confirm("Delete")).toBe(false);
    h.confirmation.destroy();
    expect(await h.confirmation.confirm("Delete")).toBe(false);
  });

  test("shares one modal per document without invoking browser confirmation", async () => {
    const h = harness();
    h.confirmation.destroy();
    vi.stubGlobal("document", h.document);
    const nativeConfirm = vi.fn();
    vi.stubGlobal("confirm", nativeConfirm);
    const first = confirmDialog("First");
    expect(await confirmDialog("Second")).toBe(false);
    const dialog = h.document.body.querySelector("dialog")!;
    dialog.querySelector("[data-confirmation-cancel]")!.dispatch("click");
    expect(await first).toBe(false);
    expect(h.document.body.querySelectorAll("dialog")).toHaveLength(1);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});
