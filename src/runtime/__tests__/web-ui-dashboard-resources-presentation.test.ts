import { describe, expect, test } from "vitest";
import { projectBasketAttention } from "../../web-ui/app/lib/information-basket-attention.js";
import { dashboardResourcesSummary, hasDashboardResourceAttention, renderDashboardResources } from "../../web-ui/app/components/dashboard/resources-attention.js";
import type { BasketSourceStatus } from "../information-basket/contracts.js";
import { attentionSource, basketView } from "./support/dashboard-resources-fixture.js";
import { createHomeWidgetsHarness } from "./support/home-widgets-harness.js";

function issue(status: BasketSourceStatus, reason: string | null) {
  return projectBasketAttention(basketView([{ ...attentionSource, status, reason }]))[0];
}
function render(snapshot: Record<string, unknown>) {
  const h = createHomeWidgetsHarness();
  h.root.innerHTML = renderDashboardResources(snapshot);
  return h.root;
}

describe("Home Resources attention projection", () => {
  test.each([
    ["stale", "basket_source_changed", "Source changed", "reindex"],
    ["failed", "basket_source_changed_during_index", "Source changed", "reindex"],
    ["missing", "basket_source_not_found", "File unavailable", "relink"],
    ["stale", "basket_source_unavailable", "File unavailable", "relink"],
    ["failed", "basket_embedding_binding_changed", "Embedding needs attention", "settings"],
    ["failed", "basket_embedding_profile_required", "Embedding needs attention", "settings"],
    ["unsupported", "basket_source_format_unsupported", "Unsupported format", "review"],
    ["failed", "basket_pdf_page_limit", "Source exceeds a limit", "review"],
    ["failed", "basket_source_no_extractable_text", "Text could not be read", "review"],
    ["failed", "basket_source_unreadable", "File access needs attention", "review"],
    ["failed", "basket_pdf_timeout", "Indexing did not finish", "reindex"],
    ["failed", "unrecognized /private/path error", "Source needs review", "review"],
  ] as const)("maps committed %s/%s to the appropriate explicit action", (status, reason, title, action) => {
    const projected = issue(status, reason);
    expect(projected).toMatchObject({
      sourceId: attentionSource.sourceId, revision: 3, displayName: attentionSource.displayName,
      status, title, action,
    });
    expect(projected).not.toHaveProperty("path");
    expect(projected).not.toHaveProperty("reason");
    expect(JSON.stringify(projected)).not.toContain("/private/path");
  });

  test("only existing problem states produce issues; queued, indexing and ready never become errors", () => {
    for (const status of ["queued", "indexing", "ready"] as const)
      expect(projectBasketAttention(basketView([{ ...attentionSource, status }]))).toEqual([]);
    expect(projectBasketAttention(null)).toEqual([]);
    expect(projectBasketAttention(basketView([]))).toEqual([]);
  });

  test("drops malformed identities and duplicate sources without changing canonical metadata", () => {
    const view = basketView([
      attentionSource, { ...attentionSource, revision: 4 },
      { ...attentionSource, sourceId: "", revision: 4 },
      { ...attentionSource, sourceId: "invalid-revision", revision: 0 },
      { ...attentionSource, sourceId: "source-b", displayName: "  Notes\u202e\n\t.md  " },
    ]);
    const before = structuredClone(view);
    expect(projectBasketAttention(view)).toMatchObject([
      { sourceId: "source-a", revision: 3 },
      { sourceId: "source-b", displayName: "Notes .md" },
    ]);
    expect(view).toEqual(before);
    expect(issue("failed", null).action).toBe("review");
  });

  test("bounds names without leaking paths or replacing them with raw error details", () => {
    const [projected] = projectBasketAttention(basketView([{
      ...attentionSource, displayName: "🚀".repeat(250), reason: "private error body", path: "/secret/source.md",
    }]));
    expect(Array.from(projected.displayName)).toHaveLength(180);
    expect(JSON.stringify(projected)).not.toContain("/secret/");
    expect(JSON.stringify(projected)).not.toContain("private error body");
  });

  test.each([
    { enabled: false, embeddingProfileId: "local-embed" },
    { enabled: true, embeddingProfileId: null },
    { enabled: true, embeddingProfileId: "removed-profile" },
  ])("points reindex candidates to settings when indexing is unavailable: %j", (settings) => {
    const view = { ...basketView(), settings: { revision: 2, ...settings } };
    const before = structuredClone(view);
    expect(projectBasketAttention(view)).toMatchObject([{
      sourceId: "source-a", revision: 3, title: "Source changed", action: "settings", label: "Open settings",
    }]);
    expect(projectBasketAttention({ ...view, sources: [{ ...attentionSource, status: "missing" }] })[0]!.action).toBe("relink");
    expect(projectBasketAttention({ ...view, sources: [{ ...attentionSource, status: "ready" }] })).toEqual([]);
    expect(view).toEqual(before);
  });
});

describe("Home Resources presentation", () => {
  test("bounds rows and previews while preserving full issue count and exact source bindings", () => {
    const issues = projectBasketAttention(basketView(Array.from({ length: 6 }, (_, index) => ({
      ...attentionSource, sourceId: "source-" + index, revision: index + 1, displayName: "Notes " + index + ".md",
    }))));
    const root = render({ issues });
    expect(root.querySelectorAll(".home-resource-issue")).toHaveLength(3);
    expect(root.textContent).toContain("Showing 3 of 6 sources");
    expect(root.querySelectorAll(".home-resource-action").map(button => ({
      id: button.dataset.sourceId, revision: button.dataset.sourceRevision, action: button.dataset.dashboardResourceAction,
    }))).toEqual([0, 1, 2].map(index => ({ id: "source-" + index, revision: String(index + 1), action: "reindex" })));
    const summary = dashboardResourcesSummary({ issues });
    expect(summary).toMatchObject({ count: 6, status: "Needs attention", tone: "attention" });
    expect(summary.preview!.items).toHaveLength(2);
    expect(summary.preview!.badge.value).toBe(6);
  });

  test.each([{ loading: true }, { mutation: "reindex" }, { error: "Connection unavailable" }])(
    "disables source actions while status is uncertain or a mutation is active: %j", (state) => {
      const root = render({ issues: [issue("stale", "basket_source_changed")], ...state });
      expect(root.querySelector(".home-resource-action")!.disabled).toBe(true);
      expect(root.querySelector('[data-dashboard-resource-action="resources"]')!.disabled).toBe(false);
    });

  test("read failure stays actionable as a metadata retry without claiming there are no problems", () => {
    const root = render({ issues: [], error: "Status may be out of date." });
    expect(root.querySelector('[role="alert"]')!.textContent).toContain("could not be refreshed");
    expect(root.querySelector('[data-dashboard-resource-action="refresh"]')!.textContent).toBe("Retry");
    expect(root.textContent).not.toContain("0 sources");
    expect(hasDashboardResourceAttention({ issues: [], error: "offline" })).toBe(true);
    expect(dashboardResourcesSummary({ issues: [], error: "offline" }).status).toBe("Needs attention");
  });

  test("a compact read-error summary marks retained issues as last known instead of a fresh preview", () => {
    const summary = dashboardResourcesSummary({ issues: [issue("stale", "basket_source_changed")], error: "offline" });
    expect(summary).toMatchObject({ count: 1, status: "Needs attention", tone: "attention" });
    expect(summary.detail).toContain("Last known status");
    expect(summary.detail).toContain("could not be refreshed");
    expect(summary.preview).toBeUndefined();
  });

  test("hides empty, unsupported and success-only widgets without hiding actual read or mutation errors", () => {
    expect(hasDashboardResourceAttention()).toBe(false);
    expect(hasDashboardResourceAttention({ issues: [], loading: true })).toBe(false);
    expect(hasDashboardResourceAttention({ issues: [], message: "Queued" })).toBe(false);
    expect(hasDashboardResourceAttention({ supported: false, issues: [issue("missing", null)], error: "offline" })).toBe(false);
    expect(hasDashboardResourceAttention({ issues: [], mutationError: "Choose another file." })).toBe(true);
    expect(hasDashboardResourceAttention({ issues: [issue("missing", null)] })).toBe(true);
  });

  test("escapes source labels, bindings and feedback in generated markup", () => {
    const projected = issue("missing", null);
    const html = renderDashboardResources({
      issues: [{ ...projected, displayName: '<img src=x onerror="unsafe">', sourceId: 'source" onclick="unsafe' }],
      error: "<script>unsafe</script>",
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('data-source-id="source" onclick=');
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });
});
