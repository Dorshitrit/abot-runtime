import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only module.
import { createCollectionConsentDialog } from "../../web-ui/app/components/passive-learning/collection-consent-dialog.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function harness() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.body = document.createElement("body");
  const container = document.createElement("section"); document.body.append(container);
  const gate = createCollectionConsentDialog({ container });
  const dialog = document.body.querySelector("dialog")!;
  return { gate, dialog,
    checkbox: dialog.querySelector("[data-collection-consent-acknowledged]")! as FakeElement & { checked: boolean },
    proceed: dialog.querySelector("[data-collection-consent-continue]")! };
}

describe("collection awareness dialog", () => {
  test("requires an unchecked acknowledgment and links the software policies", async () => {
    const h = harness(), result = h.gate.confirm();
    expect(h.checkbox.checked).toBe(false);
    expect(h.proceed.disabled).toBe(true);
    expect(h.dialog.querySelectorAll("a").map((link) => link.attributes.get("href"))).toEqual([
      "https://abot-ai.com/terms/#software", "https://abot-ai.com/privacy/#software",
    ]);
    h.checkbox.checked = true; h.checkbox.dispatch("change");
    expect(h.proceed.disabled).toBe(false);
    h.proceed.dispatch("click");
    expect(await result).toBe(true);
    const next = h.gate.confirm();
    expect(h.checkbox.checked).toBe(false);
    expect(h.proceed.disabled).toBe(true);
    h.gate.cancel(); expect(await next).toBe(false);
  });
  test.each(["button", "cancel", "close"])("%s dismisses without approval", async (action) => {
    const h = harness(), result = h.gate.confirm();
    if (action === "button") h.dialog.querySelector("[data-collection-consent-cancel]")!.dispatch("click");
    else h.dialog.dispatch(action);
    expect(await result).toBe(false);
    expect(h.dialog.open).toBe(false);
  });
});
