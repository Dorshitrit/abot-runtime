import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component.
import { createDailyReviewDialog } from "../../web-ui/app/components/home-guidance/daily-review.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const savedMemory = {
  id: "memory-1",
  updatedAt: "2026-09-26T12:00:00Z",
  createdAt: "2026-09-26T12:00:00Z",
  content: "A saved preference",
};

function dialogHarness() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.activeElement = null;
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const onDecision = vi.fn();
  const onDismiss = vi.fn();
  const view = createDailyReviewDialog({ container: document.body, onDecision, onDismiss });
  const root = document.body.querySelector("dialog")!;
  const actions = root.querySelector(".daily-review-actions")!;
  const queryAll = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => selector === ".daily-review-actions button"
    ? actions.querySelectorAll("button")
    : queryAll(selector);
  return { view, root, onDecision, onDismiss, node: (selector: string) => root.querySelector(selector)! };
}

test.each([
  { state: "empty", items: [], index: 0, completion: "No memories to review." },
  { state: "exhausted", items: [savedMemory], index: 1, completion: "Review complete." },
])("a failed load replaces the $state state without successful completion signals", ({ items, index, completion }) => {
  const h = dialogHarness();
  const snapshot = { items, index, busy: false, error: "" };
  h.view.render(snapshot);
  expect(h.node("[data-review-card]").textContent).toBe(completion);
  h.view.open();

  const error = "Saved memories could not be loaded. Close this review and try again.";
  h.view.render({ ...snapshot, error });
  expect(h.node("[data-review-card]").textContent).toBe("Review unavailable.");
  expect(h.node("[data-review-error]").textContent).toBe(error);
  expect(h.node("[data-review-error]").hidden).toBe(false);
  expect(h.node(".daily-review-progress").hidden).toBe(true);
  expect(h.node("[data-review-count]").textContent).toBe("");
  expect(h.node("progress").value).toBe(0);
  expect(h.node(".daily-review-actions").hidden).toBe(true);
  expect(h.node("[data-review-later]").textContent).toBe("Close");
  expect(h.node(".daily-review-note").hidden).toBe(true);

  h.view.render(snapshot);
  expect(h.node("[data-review-card]").textContent).toBe(completion);
  expect(h.node("[data-review-error]").hidden).toBe(true);
  expect(h.node(".daily-review-progress").hidden).toBe(false);
  expect(h.node("progress").value).toBe(index);
  expect(h.node("[data-review-count]").textContent).toBe(`${items.length} reviewed`);
  expect(h.node("[data-review-later]").textContent).toBe("Done");
  expect(h.node(".daily-review-note").hidden).toBe(false);
  h.view.dispose();
});

test("a delete failure preserves the current memory, progress and usable decisions", () => {
  const h = dialogHarness();
  const snapshot = { items: [savedMemory], index: 0, busy: false, error: "" };
  h.view.render(snapshot);
  const paragraph = h.node("[data-review-card]").querySelector("p");
  h.node("[data-review-card]").scrollTop = 40;
  h.view.render({ ...snapshot, busy: true });
  expect(h.node("[data-review-delete]").disabled).toBe(true);
  expect(h.node("[data-review-keep]").disabled).toBe(true);

  const error = "This memory could not be deleted. Try again, or keep it for now.";
  h.view.render({ ...snapshot, error });
  expect(h.node("[data-review-card]").querySelector("p")).toBe(paragraph);
  expect(paragraph!.textContent).toBe(savedMemory.content);
  expect(h.node("[data-review-card]").scrollTop).toBe(40);
  expect(h.node("[data-review-error]").textContent).toBe(error);
  expect(h.node("[data-review-error]").hidden).toBe(false);
  expect(h.node(".daily-review-progress").hidden).toBe(false);
  expect(h.node("[data-review-count]").textContent).toBe("1 of 1");
  expect(h.node(".daily-review-actions").hidden).toBe(false);
  expect(h.node("[data-review-later]").textContent).toBe("Not now");
  expect(h.node(".daily-review-note").hidden).toBe(false);
  expect(h.node("[data-review-delete]").disabled).toBe(false);
  expect(h.node("[data-review-keep]").disabled).toBe(false);
  h.node("[data-review-delete]").dispatch("click");
  h.node("[data-review-keep]").dispatch("click");
  expect(h.onDecision.mock.calls).toEqual([["delete"], ["keep"]]);
  h.view.dispose();
});
