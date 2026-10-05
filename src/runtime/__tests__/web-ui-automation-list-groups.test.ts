import { describe, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationList } from "../../web-ui/app/components/automations/list.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";

type Automation = { id: string; title: string; status: string; draftRevision: number; publishedRevision?: number; updatedAt?: string };
const automation = (id: string, status: string, publishedRevision?: number): Automation =>
  ({ id, title: id, status, draftRevision: 5, publishedRevision });

function createRoot() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const root = document.createElement("section");
  document.body.append(root);
  return { root, document };
}

function renderList(automations?: Automation[], archived = false) {
  const { root } = createRoot();
  root.innerHTML = renderAutomationList({ automations, loading: false, error: "" }, { archived });
  return root;
}

function automationIds(root: FakeElement) {
  return root.querySelectorAll("[data-select-automation]").map((row) => row.dataset.selectAutomation);
}

describe("automation list groups", () => {
  test("shows last edit time and orders each group by its latest edit without mutating the list", () => {
    const older = "2026-10-01T09:00:00Z";
    const newer = "2026-10-05T10:30:00Z";
    const entries = [
      { ...automation("a-published", "active", 1), updatedAt: older },
      { ...automation("a-draft", "draft"), updatedAt: older },
      { ...automation("z-published", "paused", 2), updatedAt: newer },
      { ...automation("z-draft", "draft"), updatedAt: newer },
    ];
    const original = structuredClone(entries);
    const root = renderList(entries);
    expect(automationIds(root)).toEqual(["z-published", "a-published", "z-draft", "a-draft"]);
    const row = root.querySelector('[data-select-automation="z-published"]')!;
    expect(row.querySelector("small")?.textContent).toContain(`Last edited ${new Date(newer).toLocaleString()}`);
    expect(entries).toEqual(original);
    entries[0].updatedAt = "2026-10-05T11:00:00Z";
    expect(automationIds(renderList(entries))).toEqual(["a-published", "z-published", "z-draft", "a-draft"]);
  });

  test("separates unpublished drafts from active and paused published automations", () => {
    const root = renderList([
      automation("draft", "draft"), automation("active", "active", 2),
      automation("paused-with-edits", "paused", 3), automation("old", "archived", 1),
    ]);
    const groups = root.querySelectorAll("[data-automation-list-group]");
    expect(groups.map((group) => group.dataset.automationListGroup)).toEqual(["published", "drafts"]);
    expect(automationIds(groups[0])).toEqual(["active", "paused-with-edits"]);
    expect(automationIds(groups[1])).toEqual(["draft"]);
    expect(groups[0].querySelector("h4")?.querySelector("span")?.textContent).toBe("2");
    expect(groups[1].querySelector("h4")?.querySelector("span")?.textContent).toBe("1");
    expect(groups[0].querySelectorAll("[data-state]").map((badge) => badge.dataset.state)).toEqual(["active", "paused"]);
    expect(groups[1].querySelector("[data-state]")?.dataset.state).toBe("draft");
    expect(root.querySelector('[data-select-automation="old"]')).toBeNull();
  });

  test("omits empty groups while preserving creation controls and the empty list state", () => {
    const drafts = renderList([automation("draft", "draft")]);
    expect(drafts.querySelector('[data-automation-list-group="published"]')).toBeNull();
    expect(drafts.querySelector('[data-automation-list-group="drafts"]')).not.toBeNull();
    const published = renderList([automation("published", "paused", 1)]);
    expect(published.querySelector('[data-automation-list-group="drafts"]')).toBeNull();
    for (const root of [renderList([]), renderList()]) {
      expect(root.querySelectorAll("[data-automation-list-group]")).toHaveLength(0);
      expect(root.querySelector(".automation-empty")).not.toBeNull();
      expect(root.querySelector('[data-action="describe"]')).not.toBeNull();
      expect(root.querySelector('[data-action="create"]')).not.toBeNull();
    }
  });

  test("keeps archived rows in their existing separate view", () => {
    const root = renderList([
      automation("draft", "draft"), automation("active", "active", 2),
      { ...automation("old", "archived", 1), updatedAt: "2026-10-01T09:00:00Z" },
      { ...automation("new", "archived", 2), updatedAt: "2026-10-05T10:30:00Z" },
    ], true);
    expect(automationIds(root)).toEqual(["new", "old"]);
    expect(root.querySelectorAll("[data-automation-list-group]")).toHaveLength(0);
    expect(root.querySelector("[data-state]")?.dataset.state).toBe("archived");
    expect(root.querySelector('[data-automation-list-filter="archived"]')?.attributes.get("aria-pressed")).toBe("true");
  });

  test("rows in both groups still open their original automation and regroup after publication", () => {
    const { root, document } = createRoot();
    const snapshot = { automations: [automation("draft", "draft"), automation("published", "active", 1)],
      selectedAutomationId: "", selectedNodeId: "", selectedRunId: "", runs: [],
      draft: null, catalog: null, error: "", feedback: "", loading: false, mutation: "" };
    const openRoute = vi.fn(async () => true);
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, openRoute } });
    root.querySelector('[data-select-automation="draft"]')!.dispatch("click");
    root.querySelector('[data-select-automation="published"]')!.dispatch("click");
    expect(openRoute.mock.calls).toEqual([["draft", ""], ["published", ""]]);
    snapshot.automations[0] = automation("draft", "paused", 5);
    workspace.render(snapshot);
    expect(root.querySelector('[data-automation-list-group="drafts"]')).toBeNull();
    expect(automationIds(root.querySelector('[data-automation-list-group="published"]')!)).toEqual(["draft", "published"]);
  });
});
