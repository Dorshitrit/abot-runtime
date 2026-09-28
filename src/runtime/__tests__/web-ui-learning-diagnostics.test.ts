import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only presentation has no declaration surface.
import { renderLearningDiagnostics } from "../../web-ui/app/components/passive-learning/diagnostics-view.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function container() {
  const documentRoot: { createElement?: (tag: string) => FakeElement } = {};
  documentRoot.createElement = tag => new FakeElement(tag, documentRoot as never);
  return new FakeElement("dl", documentRoot as never);
}

describe("Co-worker technical explanations", () => {
  test("pairs each code with its own explanation and distinguishes coverage from proactive failure", () => {
    const root = container();
    renderLearningDiagnostics(root, ["uia_application_coverage", "proactive_reason_invalid", "uia_application_coverage"]);
    const rows = root.querySelectorAll(".passive-learning-diagnostic-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("code")?.textContent).toBe("uia_application_coverage");
    expect(rows[0]?.querySelector("dd")?.textContent).toContain("not a connection failure");
    expect(rows[1]?.querySelector("code")?.textContent).toBe("proactive_reason_invalid");
    expect(rows[1]?.querySelector("dd")?.textContent).toContain("did not create a suggestion");
    renderLearningDiagnostics(root, ["learning_processing_paused"]);
    expect(root.querySelectorAll(".passive-learning-diagnostic-row")).toHaveLength(1);
    expect(root.textContent).not.toContain("proactive_reason_invalid");
  });

  test("keeps unknown safe codes visible without inventing a cause or exposing provider content", () => {
    const root = container();
    renderLearningDiagnostics(root, ["future_status_code", "provider:error with private content <img src=x>"]);
    expect(root.textContent).toContain("future_status_code");
    expect(root.textContent).toContain("No explanation is available");
    expect(root.textContent).not.toContain("private content");
    expect(root.outerHTML).not.toContain("<img");
  });
});
