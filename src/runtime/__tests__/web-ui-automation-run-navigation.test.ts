import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRunSteps, focusSelectedAutomationStep } from "../../web-ui/app/components/automations/run-steps-view.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRun } from "../../web-ui/app/components/automations/run.js";

const leaf = (id: string, kind = "agent") => ({ id, kind, title: `Step ${id}`, onFailure: "stop" });
const definition = { title: "Research", trigger: { kind: "manual" },
  body: { id: "root", kind: "sequence", children: [leaf("read", "tool"), {
    id: "group", kind: "parallel", branches: [
      { id: "branch1", kind: "sequence", children: [leaf("analyze"), leaf("check")] },
      { id: "branch2", kind: "sequence", children: [leaf("compare")] },
    ],
  }, leaf("write", "tool")] } };
const run = { id: "run", automationId: "automation", status: "failed", definition,
  nodes: [{ nodeId: "check", status: "failed" }, { nodeId: "read", status: "succeeded" }],
};

test("step navigation preserves nested workflow order, recorded failure and selected result", () => {
  const html = renderAutomationRunSteps(run, "check", "result-panel");
  const ids = [...html.matchAll(/data-automation-node="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toEqual(["read", "analyze", "check", "compare", "write"]);
  expect(html).toMatch(/data-automation-node="check" data-state="failed" aria-pressed="true"/);
  expect(html).toMatch(/data-automation-node="write" data-state="pending"/);
  expect(html).toContain('aria-controls="result-panel"');
  expect(html).not.toContain('data-automation-node="group"');
});

test("run details have room for evidence and keep configuration and diagram collapsed", () => {
  const snapshot = { run, automations: [], selectedAutomationId: "automation",
    selectedRunId: "run", selectedNodeId: "check", runs: [],
    stepEvidence: { runId: "run", nodeId: "check", title: "Step check", availability: "available",
      stepStatus: "failed", inputs: [], effects: [], output: {
        text: { value: "The checks did not pass.", truncated: false, totalCharacters: 24 }, full: false,
      } },
  };
  const html = renderAutomationRun(snapshot);
  expect(html.indexOf('aria-label="Step evidence"')).toBeLessThan(html.indexOf('data-disclosure-id="step-configuration-check"'));
  expect(html).toMatch(/<details class="automation-run-workflow" data-disclosure-id="run-workflow">/);
  expect(html).toContain('id="automation-step-result-studio-run"');
  const chatHtml = renderAutomationRun(snapshot, { locked: true });
  expect(chatHtml).toContain('id="automation-step-result-chat-run"');
  expect(chatHtml).not.toContain('id="automation-step-result-studio-run"');
});

test("explicit step selection focuses only the selected result inside its own view", () => {
  const selected = { focus: vi.fn(), scrollIntoView: vi.fn(), scrollTop: 240 };
  const root = { querySelector: vi.fn(() => selected) };
  focusSelectedAutomationStep(root);
  expect(root.querySelector).toHaveBeenCalledWith("[data-selected-step-result]");
  expect(selected.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(selected.scrollTop).toBe(0);
  expect(selected.scrollIntoView).not.toHaveBeenCalled();
  expect(() => focusSelectedAutomationStep({ querySelector: () => null })).not.toThrow();
});
