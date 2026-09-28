import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component.
import { createMacPermissionDialog } from "../../web-ui/app/components/system-host/macos-permission-dialog.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function fixture(copyText = vi.fn(async (_value: string) => {})) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const container = document.createElement("section");
  const opener = Object.assign(document.createElement("button"), {
    isConnected: true,
  });
  document.body.append(container);
  document.body.append(opener);
  opener.focus();
  const controller = createMacPermissionDialog({ container, copyText });
  const dialog = document.body.querySelector("dialog")!;
  return { document, opener, controller, dialog, copyText };
}
const companionPath = "/fixture/Alice/.abot/host-companion/runtime/node";

describe("Mac permission explanation dialog", () => {
  test("opens a labelled native dialog and focuses its heading, without pre-approving", async () => {
    const f = fixture();
    const approved = vi.fn();
    const result = f.controller.confirm(companionPath).then(approved);
    expect(f.dialog.open).toBe(true);
    expect(f.dialog.attributes.get("aria-labelledby")).toBe(
      "macPermissionTitle",
    );
    expect(f.document.activeElement).toBe(f.dialog.querySelector("h2"));
    expect(
      f.dialog.querySelector("[data-mac-permission-path]")!.textContent,
    ).toBe(companionPath);
    expect(f.dialog.querySelector("details")!.open).toBe(false);
    await Promise.resolve();
    expect(approved).not.toHaveBeenCalled();
    f.controller.cancel();
    await result;
  });

  test.each(["Cancel", "close button", "Escape", "external close"])(
    "%s resolves false and restores focus",
    async (action) => {
      const f = fixture();
      const result = f.controller.confirm(companionPath);
      if (action === "Cancel")
        f.dialog
          .querySelectorAll("[data-mac-permission-cancel]")[1]!
          .dispatch("click");
      if (action === "close button")
        f.dialog
          .querySelector("[data-mac-permission-cancel]")!
          .dispatch("click");
      if (action === "Escape")
        expect(
          f.dialog.dispatch("cancel").preventDefault,
        ).toHaveBeenCalledOnce();
      if (action === "external close") f.dialog.dispatch("close");
      expect(await result).toBe(false);
      expect(f.dialog.open).toBe(false);
      expect(f.document.activeElement).toBe(f.opener);
    },
  );

  test("only Continue approves and a later close cannot alter the decision", async () => {
    const f = fixture();
    const result = f.controller.confirm(companionPath);
    f.dialog.querySelector("[data-mac-permission-continue]")!.dispatch("click");
    f.dialog.dispatch("close");
    expect(await result).toBe(true);
    expect(f.dialog.open).toBe(false);
  });

  test("copies the exact literal path without interpreting markup", async () => {
    const f = fixture();
    const path = "/fixture/<Alice & Bob>/.abot/host-companion/runtime/node";
    const result = f.controller.confirm(path);
    const code = f.dialog.querySelector("[data-mac-permission-path]")!;
    expect(code.textContent).toBe(path);
    expect(code.children).toEqual([path]);
    f.dialog.querySelector("[data-mac-permission-copy]")!.dispatch("click");
    await vi.waitFor(() =>
      expect(
        f.dialog.querySelector("[data-mac-permission-feedback]")!.textContent,
      ).toBe("Companion path copied."),
    );
    expect(f.copyText).toHaveBeenCalledExactlyOnceWith(path);
    expect(f.dialog.open).toBe(true);
    f.controller.cancel();
    expect(await result).toBe(false);
  });

  test("a clipboard failure keeps consent pending and provides a keyboard copy fallback", async () => {
    const copyText = vi.fn(async (_value: string) => {
      throw new Error("clipboard denied");
    });
    const f = fixture(copyText);
    const result = f.controller.confirm(companionPath);
    f.dialog.querySelector("[data-mac-permission-copy]")!.dispatch("click");
    await vi.waitFor(() =>
      expect(
        f.dialog.querySelector("[data-mac-permission-feedback]")!.textContent,
      ).toContain("Select the path"),
    );
    expect(f.document.activeElement).toBe(
      f.dialog.querySelector("[data-mac-permission-path]"),
    );
    expect(f.dialog.open).toBe(true);
    f.controller.dispose();
    expect(await result).toBe(false);
    expect(f.document.body.querySelector("dialog")).toBeNull();
  });

  test("reuses one dialog without replacing an existing pending decision", async () => {
    const f = fixture();
    const first = f.controller.confirm(companionPath);
    expect(await f.controller.confirm("/other/node")).toBe(false);
    expect(
      f.dialog.querySelector("[data-mac-permission-path]")!.textContent,
    ).toBe(companionPath);
    f.controller.cancel();
    expect(await first).toBe(false);
    const next = f.controller.confirm(
      "/fixture/Bob/.abot/host-companion/runtime/node",
    );
    expect(f.document.body.querySelectorAll("dialog")).toHaveLength(1);
    f.controller.cancel();
    expect(await next).toBe(false);
  });
});
