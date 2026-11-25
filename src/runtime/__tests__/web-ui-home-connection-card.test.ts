import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only presentation module has no declaration surface.
import { createConnectionCard } from "../../web-ui/app/components/home-connections/card.js";
// @ts-expect-error Browser-only presentation module has no declaration surface.
import { createCompactHomeLayout } from "../../web-ui/app/components/dashboard/compact-layout.js";
// @ts-expect-error Browser-only presentation module has no declaration surface.
import { createHomeWidgetDialog } from "../../web-ui/app/components/dashboard/widget-dialog.js";
import { createHomeWidgetsHarness } from "./support/home-widgets-harness.js";

test("a live status refresh preserves the whole-card trigger and keyboard focus", () => {
  const h = createHomeWidgetsHarness();
  const card = createConnectionCard({ documentRoot: h.documentRoot, id: "socket", label: "ABot Socket", icon: "network" });
  h.root.append(card.button);
  const open = vi.fn();
  card.button.addEventListener("click", open);
  card.render({ detail: "wss://socket.test", status: "Connected", tone: "success" });
  card.button.focus();
  card.render({ detail: "Connection unavailable", status: "Status unavailable", tone: "neutral" });
  expect(h.documentRoot.activeElement).toBe(card.button);
  expect(card.button.getAttribute("aria-haspopup")).toBe("dialog");
  expect(card.button.getAttribute("aria-label")).toContain("Status unavailable");
  expect(card.button.querySelector("[data-connection-status]").dataset.tone).toBe("neutral");
  expect(card.button.querySelector("[data-connection-status]").getAttribute("aria-live")).toBe("polite");
  expect(card.button.textContent).not.toContain("Connected");
  card.button.dispatch("click");
  expect(open).toHaveBeenCalledOnce();
});

test("server-supplied labels stay text and disabled states do not remove the preview", () => {
  const h = createHomeWidgetsHarness();
  const card = createConnectionCard({ documentRoot: h.documentRoot, id: "computer", label: "Computer access", icon: "computer" });
  const detail = '<img src=x onerror="bad()">';
  card.render({ detail, status: "<script>bad()</script>", tone: "unknown-tone", disabled: true });
  expect(card.button.disabled).toBe(true);
  expect(card.button.querySelector("[data-connection-detail]").textContent).toBe(detail);
  expect(card.button.querySelector("img")).toBeNull();
  expect(card.button.querySelector("script")).toBeNull();
  expect(card.button.querySelector("[data-connection-status]").dataset.tone).toBe("neutral");
});

test("a dedicated service keeps its external widget mount without a duplicate compact Home card", () => {
  const h = createHomeWidgetsHarness(1200);
  const layout = createCompactHomeLayout({ root: h.root, content: h.content });
  const beforeOpen = vi.fn(() => expect(h.source.parentElement).toBe(h.sourceParent));
  layout.register({ id: "computer", label: "Computer access", icon: "computer", element: h.source,
    homeCard: false, onBeforeOpen: beforeOpen, getSummary: () => ({ title: "Mac", status: "Connected" }) });
  layout.setEnabled(true);
  expect(h.button("computer")).toBeNull();
  const mountRoot = h.createElement("section");
  h.homeRegion.append(mountRoot);
  const mount = layout.mount(mountRoot, "computer");
  mount.setActive(true);
  const trigger = mountRoot.querySelector("button")!;
  trigger.focus();
  trigger.dispatch("click");
  expect(beforeOpen).toHaveBeenCalledOnce();
  expect(h.homeRegion.querySelector("dialog")!.contains(h.source)).toBe(true);
  layout.close();
  expect(h.source.parentElement).toBe(h.sourceParent);
  expect(h.documentRoot.activeElement).toBe(trigger);
  mount.dispose();
  layout.dispose();
});

test("independent detail dialogs retain distinct accessible titles", () => {
  const h = createHomeWidgetsHarness();
  const defaultDialog = createHomeWidgetDialog({ root: h.root, onClosed: vi.fn() });
  const computerDialog = createHomeWidgetDialog({ root: h.homeRegion, onClosed: vi.fn(), titleId: "home-computer-detail-title" });
  const dialogs = h.homeRegion.querySelectorAll("dialog");
  expect(dialogs.map(dialog => dialog.getAttribute("aria-labelledby")))
    .toEqual(["home-widget-detail-title", "home-computer-detail-title"]);
  expect(dialogs.map(dialog => dialog.querySelector("h2")!.getAttribute("id")))
    .toEqual(["home-widget-detail-title", "home-computer-detail-title"]);
  computerDialog.dispose();
  defaultDialog.dispose();
});
