import { expect, test, vi } from "vitest";
import { ContextElement } from "./support/composer-context-window-dom.js";
// @ts-expect-error Browser view.
import { createSparkHomeRunActivity } from "../../web-ui/app/components/spark-home/run-activity.js";

test("HOME permission view uses existing card rendering with independent HOME callbacks", () => {
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) };
  const root = new ContextElement("section"); const onDecision = vi.fn(); const onCancel = vi.fn();
  const view = createSparkHomeRunActivity({ root, documentRoot, onDecision, onCancel });
  const run = { runId: "home-r", status: "awaiting_approval", phase: "collect",
    pendingApproval: { approvalId: "home-a", tool: "web_search", summary: "Read the selected source", meta: { query: "chosen topic" } } };
  view.render({ run, busy: false, connected: true, error: "" });
  expect(root.textContent).toContain("HOME needs your approval");
  root.querySelector(".approve")!.dispatch("click");
  expect(onDecision).toHaveBeenCalledExactlyOnceWith("home-a", true);
  root.querySelector(".spark-home-action")!.dispatch("click"); expect(onCancel).toHaveBeenCalledOnce();
  expect(root.querySelector("textarea")?.getAttribute("aria-label")).not.toBe("Message SPARK");
  view.render({ run, busy: true, connected: true, error: "" });
  expect(root.querySelector(".approve")!.disabled).toBe(true);
  view.render({ run: { ...run, status: "completed", pendingApproval: null }, busy: false, connected: true, error: "" });
  expect(root.querySelector(".approval-message-row")).toBeNull();
  expect(root.querySelector(".spark-home-action")!.hidden).toBe(true);
});

test("widget minimum rejection explains that nothing was saved and exposes no active-run controls", () => {
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) };
  const root = new ContextElement("section"); const onDecision = vi.fn(); const onCancel = vi.fn();
  const view = createSparkHomeRunActivity({ root, documentRoot, onDecision, onCancel });
  const run = { runId: "home-r", status: "failed", phase: "publish", errorCode: "spark_home_dashboard_widgets_required" };
  view.render({ run, busy: false, connected: true, error: "" });
  expect(root.textContent).toContain("fewer than three Dashboard widgets");
  expect(root.textContent).toContain("not saved");
  expect(root.querySelector(".spark-home-action")!.hidden).toBe(true);
  expect(root.querySelector(".approval-message-row")).toBeNull();
  expect(onDecision).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  view.render({ run: { ...run, status: "interrupted" }, busy: false, connected: true, error: "" });
  expect(root.textContent).toContain("HOME stopped without replacing your screen.");
});
