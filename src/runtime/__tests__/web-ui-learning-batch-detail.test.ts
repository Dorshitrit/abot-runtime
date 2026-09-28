import { expect, test } from "vitest";
// @ts-ignore Browser-only component has no declaration surface.
import { learningBatchStatusLabel, renderLearningBatchDetail } from "../../web-ui/app/components/passive-learning/batch-detail.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function detailContainer() {
  const documentRoot: { createElement?: (tag: string) => FakeElement } = {};
  documentRoot.createElement = (tag) => new FakeElement(tag, documentRoot as never);
  return new FakeElement("div", documentRoot as never);
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    id: "observation-1",
    timestamp: "2026-09-24T05:08:12Z",
    kind: "view",
    source: { app: "firefox", title: "Work <notes>" },
    content: "A page with <script>unsafe text</script>",
    coverage: "partial",
    coverageReason: "visible_accessibility_subset",
    ...overrides,
  };
}

function snapshot(observations: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    selectedBatchId: "batch-1",
    selectedBatch: {
      id: "batch-1",
      status: "saved",
      observations,
      recordIds: ["memory-1"],
    },
    detailError: "",
    loadingDetail: false,
    ...overrides,
  };
}

test("shows a compact, closed disclosure for each observation with safe full text", () => {
  const container = detailContainer();
  renderLearningBatchDetail(container, snapshot([observation()]));
  expect(container.hidden).toBe(false);
  expect(container.querySelector("header")?.textContent).toContain("Completed · 1 observation · 1 saved");
  const row = container.querySelector("details")!;
  expect(row.open).toBe(false);
  expect(row.querySelector(".passive-learning-observation-app")?.textContent).toBe("firefox");
  expect(row.querySelector(".passive-learning-observation-source")?.textContent).toBe("Work <notes>");
  expect(row.querySelector("summary")?.textContent).toContain("Viewed");
  expect(row.querySelector(".passive-learning-observation-source")?.attributes.get("dir")).toBe("auto");
  const fullText = row.querySelector("pre")!;
  expect(fullText.textContent).toBe("A page with <script>unsafe text</script>");
  expect(fullText.attributes.get("dir")).toBe("auto");
  expect(fullText.attributes.get("tabindex")).toBe("0");
  expect(container.outerHTML).toContain("&lt;script>");
  expect(container.outerHTML).not.toContain("<script>");
  expect(row.querySelector(".passive-learning-observation-diagnostics")?.textContent).toContain("visible_accessibility_subset");
  expect(row.querySelector(".passive-learning-observation-diagnostics")?.open).toBe(false);
});

test("labels empty revisits and unreadable sources without pretending text was captured", () => {
  const container = detailContainer();
  renderLearningBatchDetail(container, snapshot([
    observation({ id: "return", kind: "activity", content: "", revisitsObservationId: "previous" }),
    observation({ id: "unreadable", source: { app: "Notepad" }, content: "", coverage: "metadata_only" }),
  ]));
  const [revisit, unreadable] = container.querySelectorAll(".passive-learning-observation");
  expect(revisit.querySelector("summary")?.textContent).toContain("Returned to this app");
  expect(revisit.querySelector("pre")?.textContent).toBe("No new text since the previous view.");
  expect(unreadable.querySelector("summary")?.textContent).toContain("Notepad");
  expect(unreadable.querySelector("pre")?.textContent).toMatch(/did not expose readable text/);
});

test("handles unselected, loading, failed and empty batches", () => {
  const container = detailContainer();
  renderLearningBatchDetail(container, snapshot([], { selectedBatchId: "" }));
  expect(container.hidden).toBe(true);
  renderLearningBatchDetail(container, snapshot([], { loadingDetail: true }));
  expect(container.textContent).toMatch(/Loading review details/);
  renderLearningBatchDetail(container, snapshot([], { detailError: "Unavailable <now>" }));
  expect(container.textContent).toBe("Review details could not be loaded. Refresh to try again.");
  expect(container.textContent).not.toContain("Unavailable <now>");
  expect(container.outerHTML).not.toContain("<now>");
  renderLearningBatchDetail(container, snapshot([]));
  expect(container.textContent).toContain("No observations were included");
});

test("batch status labels remain factual", () => {
  expect(learningBatchStatusLabel("pending")).toBe("Waiting");
  expect(learningBatchStatusLabel("processing")).toBe("Reviewing");
  expect(learningBatchStatusLabel("saved")).toBe("Completed");
  expect(learningBatchStatusLabel("discarded")).toBe("Discarded");
  expect(learningBatchStatusLabel("failed")).toBe("Failed");
  expect(learningBatchStatusLabel("cancelled")).toBe("Cancelled");
});
