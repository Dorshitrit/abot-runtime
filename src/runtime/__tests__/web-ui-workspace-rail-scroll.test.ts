import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only JavaScript module.
import { createWorkspaceRailScroll } from "../../web-ui/app/components/workspace-rail-scroll.js";
import { createRailScrollHarness } from "./support/workspace-rail-scroll-harness.js";

function fixture(options: Parameters<typeof createRailScrollHarness>[0] = {}) {
  const h = createRailScrollHarness(options);
  const controller = createWorkspaceRailScroll(h);
  h.flushFrames();
  return { ...h, controller };
}

describe("compact workspace rail scrolling", () => {
  test("keeps the original navigation and footer, with arrows only for hidden content", () => {
    const h = fixture();
    expect(h.actions.parentElement).toBe(h.frame());
    expect(h.actions.children).toEqual(h.buttons);
    expect(h.footer.parentElement).toBe(h.rail);
    expect(h.frame().dataset.railOverflow).toBe("true");
    expect(h.up().disabled).toBe(true);
    expect(h.down().disabled).toBe(false);
    expect(h.actions.dataset).toMatchObject({ scrollAbove: "false", scrollBelow: "true" });
    expect(h.down().attributes.get("aria-label")).toBeTruthy();
  });

  test("does not reserve overflow state for content that fits the whole frame", () => {
    const h = fixture({ count: 5, height: 240 });
    expect(h.frame().dataset.railOverflow).toBe("false");
    expect(h.up().disabled).toBe(true);
    expect(h.down().disabled).toBe(true);
    expect(h.actions.dataset).toMatchObject({ scrollAbove: "false", scrollBelow: "false" });
  });

  test("arrow clicks and native scrolling update edges without pulling back to the active item", () => {
    const h = fixture();
    h.down().dispatch("click"); h.flushFrames();
    expect(h.actions.scrollTop).toBeGreaterThan(0);
    expect(h.actions.scrollBy).toHaveBeenLastCalledWith({ top: h.actions.clientHeight * 0.7, behavior: "smooth" });
    expect(h.up().disabled).toBe(false);
    const middle = h.actions.scrollTop;
    h.actions.dispatch("scroll"); h.flushFrames();
    expect(h.actions.scrollTop).toBe(middle);
    h.actions.scrollTop = h.actions.scrollHeight; h.flushFrames();
    expect(h.down().disabled).toBe(true);
    expect(h.actions.dataset.scrollBelow).toBe("false");
    h.up().dispatch("click"); h.flushFrames();
    expect(h.actions.scrollBy).toHaveBeenLastCalledWith({ top: -h.actions.clientHeight * 0.7, behavior: "smooth" });
  });

  test("reduced motion uses immediate scrolling", () => {
    const h = fixture({ reducedMotion: true });
    h.down().dispatch("click");
    expect(h.actions.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
  });

  test("keyboard focus reveals an offscreen item without scrolling the application", () => {
    const h = fixture();
    const last = h.buttons.at(-1)!;
    last.focus(); last.dispatch("focusin"); h.flushFrames();
    expect(h.actions.scrollTop).toBeGreaterThan(0);
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(h.actions.getBoundingClientRect().bottom);
    expect(last.scrollIntoView).not.toHaveBeenCalled();
    expect(h.rail.scrollTop).toBe(0);
    expect(h.footer.scrollTop).toBe(0);
    expect(h.documentRoot.activeElement).toBe(last);
  });

  test("a new active destination is revealed but unrelated mutations preserve user scrolling", () => {
    const h = fixture();
    const last = h.buttons.at(-1)!;
    h.buttons[0].removeAttribute("aria-current"); last.setAttribute("aria-current", "page"); h.mutate();
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(h.actions.getBoundingClientRect().bottom);
    h.actions.scrollTop = 0; h.flushFrames();
    last.setAttribute("class", "rail-button has-unread"); h.mutate();
    expect(h.actions.scrollTop).toBe(0);
  });

  test("dynamic insertion and hiding switch overflow off using the whole available height", () => {
    const h = fixture({ count: 5, height: 240 });
    const inserted = h.addButton(); h.mutate();
    expect(h.frame().dataset.railOverflow).toBe("true");
    inserted.hidden = true; h.mutate();
    expect(h.frame().dataset.railOverflow).toBe("false");
    expect(h.actions.clientHeight).toBe(240);
    expect(h.up().disabled).toBe(true);
    expect(h.down().disabled).toBe(true);
  });

  test("resizing reveals the selected item and removes obsolete overflow controls", () => {
    const h = fixture({ height: 600 });
    h.buttons[0].removeAttribute("aria-current");
    const last = h.buttons.at(-1)!; last.setAttribute("aria-current", "page"); h.mutate();
    h.resize(240);
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(h.actions.getBoundingClientRect().bottom);
    h.resize(600);
    expect(h.frame().dataset.railOverflow).toBe("false");
    expect(h.down().disabled).toBe(true);
  });

  test.each(["labels", "mobile"])("%s keeps its existing scroll owner without compact decoration", (mode) => {
    const h = fixture();
    if (mode === "labels") h.navigation("labels");
    else h.desktop(false);
    expect(h.frame().dataset.railOverflow).toBeUndefined();
    expect(h.actions.dataset.scrollAbove).toBeUndefined();
    expect(h.actions.dataset.scrollBelow).toBeUndefined();
    expect(h.up().disabled).toBe(true);
    expect(h.down().disabled).toBe(true);
    h.actions.scrollTop = 100; h.flushFrames();
    expect(h.actions.scrollTop).toBe(100);
    h.navigation("icons"); h.desktop(true);
    expect(h.frame().dataset.railOverflow).toBe("true");
    expect(h.actions.scrollTop).toBe(0);
  });

  test("keyboard activation does not leave focus on a disabled terminal arrow", () => {
    const h = fixture();
    h.down().focus();
    h.actions.scrollTop = h.actions.scrollHeight; h.flushFrames();
    expect(h.down().disabled).toBe(true);
    expect(h.documentRoot.activeElement).toBe(h.buttons.at(-1));
    h.up().focus();
    h.actions.scrollTop = 0; h.flushFrames();
    expect(h.documentRoot.activeElement).toBe(h.buttons[0]);
  });

  test("destroy cancels pending work, detaches observers and restores the original structure", () => {
    const h = fixture();
    h.controller.refresh();
    h.controller.destroy();
    h.flushFrames();
    expect(h.actions.parentElement).toBe(h.rail);
    expect(h.rail.children).toEqual([h.actions, h.footer]);
    expect(h.frame()).toBeNull();
    expect(h.actions.dataset.scrollAbove).toBeUndefined();
    expect(h.actions.dataset.scrollBelow).toBeUndefined();
    for (const observer of [...h.resizeObservers, ...h.mutationObservers]) expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(h.actions.listeners.get("scroll")).toEqual([]);
    expect(h.actions.listeners.get("focusin")).toEqual([]);
    h.controller.refresh();
    expect(h.frames.size).toBe(0);
  });

  test("missing navigation remains a no-op for shell consumers", () => {
    expect(createWorkspaceRailScroll({ rail: null })).toBeNull();
  });
});
