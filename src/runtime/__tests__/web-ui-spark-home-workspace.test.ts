import { expect, test, vi } from "vitest";
// @ts-expect-error Browser component.
import { createSparkHomeWorkspace } from "../../web-ui/app/components/spark-home/workspace.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function harness() {
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) };
  const root = Object.assign(new ContextElement("section"), { ownerDocument: documentRoot });
  const header = new ContextElement("header"); header.className = "home-workspace-header";
  const dashboard = new ContextElement("div");
  const draft = new ContextElement("textarea"); draft.textContent = "Retained ordinary draft";
  dashboard.appendChild(draft); root.append(header, dashboard);
  const actions = { onMode: vi.fn(), onRequest: vi.fn(), onTalk: vi.fn(), onSetup: vi.fn(), onRetry: vi.fn(), onContentError: vi.fn() };
  const windowRoot = new EventTarget();
  const view = createSparkHomeWorkspace({ root, dashboardRoot: dashboard, documentRoot, windowRoot,
    contentUrl: (revision: number, environment: string) => `/screen?environment=${environment}&revision=${revision}`, ...actions });
  return { root, dashboard, draft, view, actions, windowRoot };
}
const base = { mode: "spark", environmentId: "dev", available: true, screen: null,
  loading: false, requesting: false, saving: false, error: "", preferenceError: "" };
test("mounts the isolated screen without replacing the existing Dashboard or draft", () => {
  const h = harness();
  h.view.render({ ...base, screen: { revision: 1, updatedAt: "first" } });
  expect(h.dashboard.hidden).toBe(true);
  const modes = h.root.querySelector(".spark-home-selector")!.children;
  expect(modes[0]!.hidden).toBe(false);
  expect(modes[1]!.hidden).toBe(true);
  expect(h.dashboard.children[0]).toBe(h.draft);
  const frame = h.root.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/screen?environment=dev&revision=1");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  h.view.render({ ...base, mode: "dashboard", screen: { revision: 1, updatedAt: "first" } });
  expect(h.dashboard.hidden).toBe(false);
  expect(modes[0]!.hidden).toBe(true);
  expect(modes[1]!.hidden).toBe(false);
  expect(h.draft.textContent).toBe("Retained ordinary draft");
  expect(h.root.querySelector("iframe")).toBe(frame);
});
test("status and loading updates preserve iframe interaction state until the committed revision changes", () => {
  const h = harness();
  const screen = { revision: 1, updatedAt: "first" };
  h.view.render({ ...base, screen });
  const frame = h.root.querySelector("iframe");
  const status = h.root.querySelector(".spark-home-status")!;
  expect(status.hidden).toBe(true);
  h.view.render({ ...base, screen, loading: true });
  expect(status.hidden).toBe(true);
  expect(h.root.querySelector("iframe")).toBe(frame);
  expect(h.root.querySelector(".spark-home-frame-host")!.hidden).toBe(false);
  h.view.render({ ...base, screen, loading: false });
  expect(status.hidden).toBe(true);
  h.view.render({ ...base, screen, mode: "dashboard" });
  h.view.render({ ...base, screen, mode: "spark", loading: true });
  expect(status.hidden).toBe(true);
  expect(h.root.querySelector("iframe")).toBe(frame);
  expect(h.root.querySelector(".spark-home-frame-host")!.hidden).toBe(false);
  h.view.render({ ...base, screen, requesting: true });
  expect(status.hidden).toBe(false);
  h.view.render({ ...base, screen, loading: true });
  expect(h.root.querySelector("iframe")).toBe(frame);
  expect(status.hidden).toBe(true);
  h.view.render({ ...base, screen: { revision: 2, updatedAt: "second" } });
  expect(h.root.querySelector("iframe")).not.toBe(frame);
  expect(h.root.querySelector("iframe")!.getAttribute("src")).toBe("/screen?environment=dev&revision=2");
});
test("the initial screen load still has a visible loading status until metadata arrives", () => {
  const h = harness();
  h.view.render({ ...base, loading: true });
  const status = h.root.querySelector(".spark-home-status")!;
  expect(status.hidden).toBe(false);
  expect(status.textContent).toContain("Loading");
  expect(h.root.querySelector(".spark-home-empty")!.hidden).toBe(true);
  expect(h.root.querySelector("iframe")).toBeNull();
  h.view.render({ ...base, screen: { revision: 1, updatedAt: "first" } });
  expect(status.hidden).toBe(true);
  expect(h.root.querySelector("iframe")).not.toBeNull();
});
test("empty state uses existing SPARK callbacks and contains no separate conversation input", () => {
  const h = harness(); h.view.render(base);
  h.root.querySelector(".spark-home-create")!.dispatch("click");
  expect(h.actions.onRequest).toHaveBeenCalledOnce();
  expect(h.root.querySelector(".spark-home-surface")!.querySelector("textarea")).toBeNull();
  expect(h.root.querySelector("iframe")).toBeNull();
});
test("environment invalidation removes the previously displayed private document", () => {
  const h = harness();
  h.view.render({ ...base, screen: { revision: 1, updatedAt: "first" } });
  const previous = h.root.querySelector("iframe");
  h.view.render({ ...base, environmentId: "prod", loading: true });
  expect(h.root.querySelector("iframe")).toBeNull();
  h.view.render({ ...base, environmentId: "prod", screen: { revision: 1, updatedAt: "first" } });
  expect(h.root.querySelector("iframe")).not.toBe(previous);
  expect(h.root.querySelector("iframe")!.getAttribute("src")).toBe("/screen?environment=prod&revision=1");
});

test("only the current outer renderer can report a matching revision load error", () => {
  const h = harness();
  const payload = { kind: "abot.spark-home-load-error", revision: 1, error: "spark_home_content_unavailable" };
  const emit = (source: object, data: object) => h.windowRoot.dispatchEvent(Object.assign(new Event("message"), { source, data }));
  h.view.render({ ...base, screen: { revision: 1, updatedAt: "first" } });
  const outer = {};
  Object.assign(h.root.querySelector("iframe")!, { contentWindow: outer });
  emit({}, payload);
  emit(outer, { ...payload, revision: 2 });
  emit(outer, { ...payload, error: "other" });
  expect(h.actions.onContentError).not.toHaveBeenCalled();
  emit(outer, payload);
  expect(h.actions.onContentError).toHaveBeenCalledOnce();
  h.view.render({ ...base, screen: { revision: 2, updatedAt: "second" } });
  Object.assign(h.root.querySelector("iframe")!, { contentWindow: {} });
  emit(outer, { ...payload, revision: 2 });
  expect(h.actions.onContentError).toHaveBeenCalledOnce();
});

test("host toolbar keeps generation and conversation actions without a manual revision-apply button", () => {
  const h = harness();
  h.view.render({ ...base, screen: { revision: 1, updatedAt: "first" }, requesting: true });
  const toolbar = h.root.querySelector(".spark-home-toolbar")!;
  expect(toolbar.parentElement!.parentElement!.className).toBe("home-workspace-header");
  const buttons = toolbar.children;
  expect(buttons).toHaveLength(2);
  expect(buttons[0]!.disabled).toBe(true);
  expect(buttons[0]!.textContent).toBe("Creating…");
  expect(buttons[0]!.getAttribute("aria-busy")).toBe("true");
  buttons[1]!.dispatch("click");
  expect(h.actions.onTalk).toHaveBeenCalledOnce();
  h.view.render({ ...base, screen: { revision: 2, updatedAt: "second" } });
  expect(toolbar.textContent).not.toContain("Show new screen");
  buttons[0]!.dispatch("click");
  expect(h.actions.onRequest).toHaveBeenCalledOnce();
});

test.each([null, { revision: 1, updatedAt: "first" }])("manual loader covers only the canvas, including the empty state (%j)", screen => {
  const h = harness(); h.view.render({ ...base, screen });
  const frame = h.root.querySelector("iframe");
  const overlay = h.root.querySelector(".spark-home-generation")!;
  expect(overlay.hidden).toBe(true);
  h.view.render({ ...base, screen, requesting: true, generationPhase: "working" });
  expect(overlay.hidden).toBe(false);
  expect(overlay.classList.contains("spark-is-working")).toBe(true);
  expect(overlay.querySelector("img")!.getAttribute("src")).toBe("/spark-mascot.svg");
  expect(h.root.querySelector(".spark-home-frame-host")).toMatchObject({ inert: true });
  expect(h.root.querySelector(".spark-home-empty")).toMatchObject({ inert: true });
  expect(h.root.querySelector("iframe")).toBe(frame);
  expect(h.root.querySelector(".home-workspace-header")!.classList.contains("spark-home-generating")).toBe(false);
  const talk = h.root.querySelector(".spark-home-toolbar")!.children[1]!;
  expect(talk.disabled).toBe(false); talk.dispatch("click");
  expect(h.actions.onTalk).toHaveBeenCalledOnce();
  h.view.render({ ...base, screen, requesting: true, generationPhase: "approval" });
  expect(overlay.classList.contains("spark-is-working")).toBe(false);
  expect(overlay.textContent).toContain("approval");
  expect(overlay.classList.contains("spark-home-needs-approval")).toBe(true);
  expect(overlay.querySelector(".spark-home-approval-hint")!.hidden).toBe(false);
  expect(overlay.querySelector(".spark-home-generation-text")!.getAttribute("aria-live")).toBe("assertive");
  expect(overlay.querySelector("button")!.textContent).toBe("Review in SPARK");
  overlay.querySelector("button")!.dispatch("click");
  expect(h.actions.onTalk).toHaveBeenCalledTimes(2);
  expect(h.actions.onRequest).not.toHaveBeenCalled();
  h.view.render({ ...base, screen, requesting: true, generationPhase: "working" });
  expect(overlay.classList.contains("spark-home-needs-approval")).toBe(false);
  expect(overlay.classList.contains("spark-is-working")).toBe(true);
  expect(overlay.querySelector(".spark-home-approval-hint")!.hidden).toBe(true);
  expect(overlay.querySelector(".spark-home-generation-text")!.getAttribute("aria-live")).toBe("polite");
  expect(overlay.querySelector("button")!.textContent).toBe("Open SPARK");
  h.view.render({ ...base, screen, generationNotice: "Open SPARK to read its response." });
  expect(overlay.hidden).toBe(true);
  expect(h.root.querySelector(".spark-home-frame-host")).toMatchObject({ inert: false });
  expect(h.root.querySelector(".spark-home-generation-notice")!.hidden).toBe(false);
  expect(h.root.querySelector("iframe")).toBe(frame);
});
