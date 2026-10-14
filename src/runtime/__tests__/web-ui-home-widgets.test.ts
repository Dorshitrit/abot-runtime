import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createCompactHomeLayout } from "../../web-ui/app/components/dashboard/compact-layout.js";
import { createHomeWidgetsHarness } from "./support/home-widgets-harness.js";

function createLayout(width = 1280, hasMatchMedia = true) {
  const harness = createHomeWidgetsHarness(width, hasMatchMedia);
  const layout = createCompactHomeLayout(harness);
  let available = true;
  let summary = { title: "MacBook", detail: "Connected", status: "Ready", tone: "ready" };
  const onOpen = vi.fn();
  const unregister = layout.register({
    id: "computer", label: "Your computer", icon: "monitor", element: harness.source,
    getSummary: () => summary, isAvailable: () => available, onOpen,
    emptyMessage: "Nothing needs attention",
  });
  layout.setEnabled(true);
  layout.refresh();
  return {
    ...harness, layout, onOpen, unregister,
    updateSummary(detail: string) { summary = { ...summary, detail }; layout.refresh(); },
    setAvailable(value: boolean) { available = value; layout.refresh(); },
  };
}

describe("compact Home widgets reuse mounted components", () => {
  test("leaves desktop DOM and the shared composer in place", () => {
    const h = createLayout(1441);
    expect(h.viewport.matchMedia).toHaveBeenCalledWith("(max-width: 1440px)");
    expect(h.homeRegion.classList.contains("home-widgets-compact")).toBe(false);
    expect(h.source.parentElement).toBe(h.sourceParent);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.layout.open("computer")).toBe(false);
    expect(h.dialog()?.open).not.toBe(true);
    expect(h.composer.value).toBe("Keep my unsent draft");
    h.layout.dispose();
  });

  test("uses compact widgets at the exact breakpoint without hiding the live source from its owner", () => {
    const h = createLayout(1440);
    expect(h.homeRegion.classList.contains("home-widgets-compact")).toBe(true);
    expect(h.button()).not.toBeNull();
    expect(h.button()?.hidden).toBe(false);
    expect(h.source.classList.contains("home-widget-source")).toBe(true);
    expect(h.source.hidden).toBe(false);
    expect(h.source.inert).toBe(false);
    expect(h.source.closest("[hidden]")).toBeNull();
    expect(h.layout.open("computer")).toBe(true);
    expect(h.dialog()?.contains(h.source)).toBe(true);
    expect(h.layout.isExpanded(h.source)).toBe(true);
    expect(h.root.querySelectorAll(".existing-component")).toEqual([h.source]);
    expect(h.onOpen).toHaveBeenCalledOnce();
    h.layout.dispose();
  });

  test("dispatches original component callbacks once through the original Home root after repeated expansion", () => {
    const h = createLayout();
    for (let index = 0; index < 3; index += 1) {
      h.button()!.dispatch("click");
      expect(h.dialog()?.contains(h.action)).toBe(true);
      h.action.dispatch("click");
      h.layout.close();
    }
    expect(h.actionListener.mock.calls).toEqual([["request-123"], ["request-123"], ["request-123"]]);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.root.querySelectorAll(".existing-component")).toEqual([h.source]);
    h.layout.dispose();
  });

  test("refreshes the live summary while preserving an expanded component and its current state", () => {
    const h = createLayout();
    h.layout.open("computer");
    h.action.value = "Permission request in progress";
    h.updateSummary("Permissions need attention");
    expect(h.button()?.textContent).toContain("Permissions need attention");
    expect(h.dialog()?.contains(h.source)).toBe(true);
    expect(h.layout.isExpanded(h.source)).toBe(true);
    expect(h.action.value).toBe("Permission request in progress");
    expect(h.onOpen).toHaveBeenCalledOnce();
    expect(h.composer.value).toBe("Keep my unsent draft");
    h.layout.dispose();
  });

  test.each(["close button", "Escape"])("%s restores the same component and the activating widget focus", (method) => {
    const h = createLayout();
    const button = h.button()!;
    button.focus();
    button.dispatch("click");
    expect(h.dialog()?.open).toBe(true);
    if (method === "Escape") h.dialog()!.dispatch("cancel");
    if (method === "close button") h.dialog()!.querySelector("[data-home-widget-close]")!.dispatch("click");
    expect(h.dialog()?.open).toBe(false);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.layout.isExpanded(h.source)).toBe(false);
    expect(h.documentRoot.activeElement).toBe(button);
    h.layout.dispose();
  });

  test("resizing to desktop closes expansion and restores source order without modifying the draft", () => {
    const h = createLayout();
    h.layout.open("computer");
    h.resize(1441);
    expect(h.homeRegion.classList.contains("home-widgets-compact")).toBe(false);
    expect(h.dialog()?.open).toBe(false);
    expect(h.layout.isExpanded(h.source)).toBe(false);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.layout.open("computer")).toBe(false);
    expect(h.composer.value).toBe("Keep my unsent draft");
    h.resize(1440);
    expect(h.layout.open("computer")).toBe(true);
    expect(h.dialog()?.contains(h.source)).toBe(true);
    expect(h.onOpen).toHaveBeenCalledTimes(2);
    h.layout.dispose();
  });

  test("leaving Home closes expansion without taking focus from the destination workspace", () => {
    const h = createLayout();
    h.layout.open("computer");
    const destination = h.createElement("button");
    h.documentRoot.body.append(destination);
    destination.focus();
    h.layout.setWorkspace("chat");
    expect(h.dialog()?.open).toBe(false);
    expect(h.source.parentElement).toBe(h.sourceParent);
    expect(h.documentRoot.activeElement).toBe(destination);
    expect(h.layout.open("computer")).toBe(false);
    h.layout.setWorkspace("home");
    expect(h.layout.open("computer")).toBe(true);
    h.layout.dispose();
  });

  test.each([false, true])("desktop resize restores visible focus from a closed widget with source hidden=%s", (hidden) => {
    const h = createLayout();
    if (hidden) h.source.setAttribute("hidden", "");
    h.button()!.focus();
    h.resize(1441);
    expect(h.documentRoot.activeElement).toBe(hidden ? h.composer : h.action);
    h.layout.dispose();
  });

  test("onboarding disables widget actions, restores sources, and supports returning to configured Home", () => {
    const h = createLayout();
    h.layout.open("computer");
    h.layout.setEnabled(false);
    expect(h.homeRegion.classList.contains("home-widgets-compact")).toBe(false);
    expect(h.dialog()?.open).toBe(false);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.layout.open("computer")).toBe(false);
    h.layout.setEnabled(true);
    expect(h.layout.open("computer")).toBe(true);
    expect(h.root.querySelectorAll(".existing-component")).toEqual([h.source]);
    h.layout.dispose();
  });

  test("unavailable entries cannot expand and availability can be restored", () => {
    const h = createLayout();
    h.setAvailable(false);
    expect(h.layout.open("computer")).toBe(false);
    h.setAvailable(true);
    expect(h.layout.open("computer")).toBe(true);
    h.layout.dispose();
  });

  test("availability revoked during expansion closes the view and restores the same source", () => {
    const h = createLayout();
    h.layout.open("computer");
    h.setAvailable(false);
    expect(h.dialog()?.open).toBe(false);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.button()?.hidden).toBe(true);
    h.layout.dispose();
  });

  test("a native dialog close event also restores its borrowed component", () => {
    const h = createLayout();
    const button = h.button()!;
    button.focus();
    button.dispatch("click");
    h.dialog()!.close();
    h.dialog()!.dispatch("close");
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.layout.isExpanded(h.source)).toBe(false);
    expect(h.documentRoot.activeElement).toBe(button);
    h.layout.dispose();
  });

  test("a queued close event from the previous expansion cannot detach a newly opened component", () => {
    const h = createLayout();
    const second = h.createElement("section");
    h.sourceParent.append(second);
    h.layout.register({ id: "activity", label: "Activity", element: second,
      getSummary: () => ({ title: "A live run", detail: "", status: "Running" }) });
    h.layout.open("computer");
    h.layout.open("activity");
    h.dialog()!.dispatch("close");
    expect(h.dialog()!.open).toBe(true);
    expect(h.dialog()!.contains(second)).toBe(true);
    expect(h.layout.isExpanded(second)).toBe(true);
    expect(h.source.parentElement).toBe(h.sourceParent);
    h.layout.close();
    expect(second.parentElement).toBe(h.sourceParent);
    h.layout.dispose();
  });

  test("shows empty-state feedback without unhiding an owner-hidden component", () => {
    const h = createLayout();
    h.source.hidden = true;
    h.source.setAttribute("hidden", "");
    h.layout.refresh();
    expect(h.layout.open("computer")).toBe(true);
    expect(h.dialog()?.textContent).toContain("Nothing needs attention");
    expect(h.source.hidden).toBe(true);
    h.layout.close();
    expect(h.source.hidden).toBe(true);
    h.layout.dispose();
  });

  test("unregistering an expanded component restores ownership and removes its entry", () => {
    const h = createLayout();
    h.layout.open("computer");
    h.unregister();
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.dialog()?.open).toBe(false);
    expect(h.button()).toBeNull();
    expect(h.layout.open("computer")).toBe(false);
    h.layout.dispose();
  });

  test("disposal restores nodes, removes media listeners, and leaves no modal open", () => {
    const h = createLayout();
    h.layout.open("computer");
    h.layout.dispose();
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    expect(h.mediaListeners.size).toBe(0);
    expect(h.dialog()?.open).not.toBe(true);
    h.resize(1441);
    h.resize(1280);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
  });

  test("keeps the existing desktop layout when matchMedia is unavailable", () => {
    const h = createLayout(1280, false);
    expect(h.layout.open("computer")).toBe(false);
    expect(h.sourceParent.children).toEqual([h.source, h.following]);
    h.layout.dispose();
  });
});
