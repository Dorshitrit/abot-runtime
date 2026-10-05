import { escapeHtml } from "../../lib/text-format.js";

export function workflowSteps(node) {
  if (!node) return [];
  if (node.kind === "tool" || node.kind === "agent") return [node];
  const children = node.kind === "parallel" ? node.branches : node.children;
  return (Array.isArray(children) ? children : []).flatMap(workflowSteps);
}

/** Preserve workflow order while showing the recorded state of each step. */
export function renderAutomationRunSteps(run, selectedNodeId, detailId) {
  const states = new Map((run.nodes || run.report?.nodeResults || []).map((node) => [node.nodeId, node]));
  const steps = workflowSteps(run.definition?.body);
  if (!steps.length) return "";
  return `<section class="automation-run-steps" aria-label="Run steps"><h4>Steps</h4>
    <p class="automation-muted">Select a step to read its result and inspect its inputs.</p>
    <ol class="automation-run-step-list">${steps.map((node, index) => {
      const state = states.get(node.id)?.status || "pending";
      return `<li><button type="button" data-automation-node="${escapeHtml(node.id)}" data-state="${escapeHtml(state)}" aria-pressed="${node.id === selectedNodeId}" aria-controls="${escapeHtml(detailId)}">
        <span class="automation-run-step-index" aria-hidden="true">${index + 1}</span>
        <span class="automation-run-step-copy"><strong dir="auto">${escapeHtml(node.title || "Untitled step")}</strong>
          <small>${node.kind === "agent" ? "Agent" : "Tool"} · ${escapeHtml(state.replaceAll("_", " "))}</small></span>
        <span class="automation-run-step-open" aria-hidden="true">→</span></button></li>`;
    }).join("")}</ol></section>`;
}

/** Only a deliberate result-selection action moves focus; live refresh never does. */
export function focusSelectedAutomationStep(root) {
  const detail = root.querySelector("[data-selected-step-result]");
  if (!detail) return;
  detail.scrollTop = 0;
  detail.focus({ preventScroll: true });
}
