import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only component has no declaration surface.
import { handleKnowledgeClick, learningKnowledgeMarkup, renderLearningKnowledge } from "../../web-ui/app/components/passive-learning/knowledge-view.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function harness() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const root = document.createElement("section");
  root.innerHTML = learningKnowledgeMarkup();
  const query = (selector: string) => root.querySelector(selector)!;
  const click = (direction: string) => handleKnowledgeClick(root, {
    target: query(`[data-learning-knowledge-page="${direction}"]`), preventDefault: vi.fn(),
  });
  return { root, document, query, click };
}

function snapshot(count = 1) {
  return { environmentId: "dev", loadingCandidates: false, candidateError: "",
    candidates: Array.from({ length: count }, (_, index) => ({ id: `candidate-${index}`, content: `Pattern ${index}`,
      reason: "Observed across separate sessions.", score: 65, lastReinforcedAt: "2026-09-25T09:00:00Z", expiresAt: "2026-10-25T09:00:00Z" })),
    status: { preferences: { maturation: { promotionScore: 90 } }, recentMemories: [
      { id: "memory-1", content: "Prefers concise answers.", createdAt: "2026-09-25T08:00:00Z" },
    ] },
  };
}

describe("Co-worker knowledge view", () => {
  it("presents candidate judgment and recent memory separately with safe mixed-direction text", () => {
    const h = harness();
    const data = snapshot();
    data.candidates[0]!.content = 'דוגמה <script>alert("x")</script>';
    data.candidates[0]!.reason = '<img src="x" onerror="alert(1)">';
    data.status.recentMemories[0]!.content = "<button>Memory</button>";
    renderLearningKnowledge(h.root, data);
    expect(h.root.querySelector("script")).toBeNull();
    expect(h.root.querySelector("img")).toBeNull();
    expect(h.query("[data-learning-candidates]").textContent).toContain(data.candidates[0]!.content);
    expect(h.query("[data-learning-saved]").textContent).toContain("<button>Memory</button>");
    expect(h.query("[data-learning-candidates]").querySelector("[dir=\"auto\"]")).not.toBeNull();
    expect(h.root.textContent).toContain("Scores are model judgments, not probabilities.");
    expect(h.query("[data-learning-threshold]").textContent).toBe("Promote at 90");
    expect(h.query("[data-learning-history-note]").textContent).toContain("full list");
    expect(h.root.textContent).not.toContain("protected");
  });

  it("makes all 500 candidates reachable while rendering at most 20 at once", () => {
    const h = harness();
    renderLearningKnowledge(h.root, snapshot(500));
    const visited: string[] = [];
    for (let page = 0; page < 25; page += 1) {
      const records = h.root.querySelectorAll("[data-learning-candidate-id]");
      expect(records).toHaveLength(20);
      visited.push(...records.map((record) => record.dataset.learningCandidateId!));
      expect(h.click("next")).toBe(page < 24);
    }
    expect(new Set(visited).size).toBe(500);
    expect(h.query("[data-learning-page-summary]").textContent).toBe("481–500 of 500");
    expect(h.click("previous")).toBe(true);
    expect(h.query("[data-learning-page-summary]").textContent).toBe("461–480 of 500");
  });

  it("keeps complete long text expandable and places supporting evidence inside native details", () => {
    const h = harness();
    const data = snapshot();
    const content = `מידע ארוך ${"A useful observation. ".repeat(35)}<complete ending>`;
    data.candidates[0]!.content = content;
    data.status.recentMemories[0]!.content = content;
    renderLearningKnowledge(h.root, data);
    const record = h.query("[data-learning-candidate-id]");
    const reading = record.querySelector(".co-worker-record-reading")!;
    const explanation = record.querySelector(".co-worker-record-details")!;
    expect(reading.querySelector(".co-worker-record-content")!.textContent).toBe(content);
    expect(h.query("[data-learning-saved]").querySelector(".co-worker-record-content")!.textContent).toBe(content);
    expect(explanation.querySelector(".co-worker-record-reason")!.textContent).toBe(data.candidates[0]!.reason);
    expect(explanation.querySelectorAll("time")).toHaveLength(2);
    expect(explanation.open).toBe(false);
    reading.open = true;
    reading.querySelector("summary")!.focus();
    renderLearningKnowledge(h.root, { ...data, loadingCandidates: true });
    expect(record.querySelector(".co-worker-record-reading")).toBe(reading);
    expect(reading.open).toBe(true);
    expect(h.document.activeElement).toBe(reading.querySelector("summary"));
  });

  it("preserves open details and focus during unrelated events and background refreshes", () => {
    const h = harness();
    const data = snapshot();
    renderLearningKnowledge(h.root, data);
    const candidate = h.query("[data-learning-candidate-id]");
    const details = candidate.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    const memory = h.query("[data-learning-saved]").querySelector("article");
    details.open = true;
    summary.focus();
    renderLearningKnowledge(h.root, { ...data, loadingCandidates: true, candidateError: "Temporary failure",
      status: { ...data.status, processing: true, preferences: { maturation: { promotionScore: 90 } } } });
    expect(h.query("[data-learning-candidate-id]")).toBe(candidate);
    expect(h.query("[data-learning-saved]").querySelector("article")).toBe(memory);
    expect(details.open).toBe(true);
    expect(h.document.activeElement).toBe(summary);
    expect(h.query("[data-learning-threshold]").textContent).toBe("Promote at 90");
    expect(h.query("[data-learning-candidate-note]").textContent).toContain("Temporary failure");
  });

  it("distinguishes loading, failed reads and an empty list without claiming all memory is empty", () => {
    const h = harness();
    const data = snapshot(0);
    data.status.recentMemories = [];
    renderLearningKnowledge(h.root, { ...data, loadingCandidates: true });
    expect(h.query("[data-learning-candidates]").textContent).toContain("Loading candidates");
    renderLearningKnowledge(h.root, { ...data, candidateError: "Unavailable" });
    expect(h.query("[data-learning-candidates]").textContent).toContain("unavailable");
    renderLearningKnowledge(h.root, data);
    expect(h.query("[data-learning-candidates]").textContent).toContain("No candidates yet");
    expect(h.query("[data-learning-saved]").textContent).toContain("No recent memories learned from activity");
    expect(h.query("[data-learning-pagination]").hidden).toBe(true);
  });

  it("clamps a shrinking list and resets pagination when the selected environment changes", () => {
    const h = harness();
    renderLearningKnowledge(h.root, snapshot(45));
    h.click("next");
    h.click("next");
    renderLearningKnowledge(h.root, snapshot(21));
    expect(h.query("[data-learning-page-summary]").textContent).toBe("21–21 of 21");
    renderLearningKnowledge(h.root, { ...snapshot(45), environmentId: "other" });
    expect(h.query("[data-learning-page-summary]").textContent).toBe("1–20 of 45");
  });
});
