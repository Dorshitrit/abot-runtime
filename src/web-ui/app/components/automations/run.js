import { escapeHtml } from "../../lib/text-format.js";
import { findAutomationNode, renderAutomationNodeDetails, renderAutomationTimeline } from "./timeline.js";
import { renderAutomationReport, renderAutomationStepEvidence } from "./run-report-view.js";
import { renderAutomationRunSteps } from "./run-steps-view.js";
import { renderAutomationRunHistory } from "./run-history.js";

function runIsActive(run) {
  return ["running", "stopping", "pending"].includes(run?.status);
}

export function renderAutomationRun(snapshot, { locked = false } = {}) {
  const run = snapshot.run;
  const current = snapshot.automations.find((item) => item.id === snapshot.selectedAutomationId);
  const title = run?.definition?.title || current?.title || "Automation";
  const definitionRevision = run?.definitionRevision ?? run?.target?.definitionRevision ?? run?.definition?.revision;
  const selectedNode = run?.definition ? findAutomationNode(run.definition.body, snapshot.selectedNodeId) : null;
  const detailId = `automation-step-result-${locked ? "chat" : "studio"}-${run?.id || "none"}`;
  const runPending = Boolean(snapshot.runStartPending);
  const rerunDisabled = runPending || snapshot.loading || Boolean(snapshot.mutation);
  return `<div class="automation-workspace" data-automation-view="run">
    <div class="automation-heading"><div><button type="button" class="automation-text-button" data-action="${locked ? "return-studio" : "editor"}">← ${locked ? "ABot Studio" : "Editor"}</button><h3 dir="auto">${escapeHtml(title)}</h3><p>${run ? `Read-only run${definitionRevision ? ` · Revision ${escapeHtml(definitionRevision)}` : ""}` : "Select a saved run"}</p></div>
      <div class="automation-actions">${!locked && run ? `<button type="button" data-action="open-chat-run">Open read-only view</button>` : ""}${runIsActive(run) && run?.status !== "stopping" ? `<button type="button" class="automation-stop" data-action="stop">Stop run</button>` : ""}${!locked && run && !runIsActive(run) && current?.status !== "archived" ? `<button type="button" data-action="rerun"${rerunDisabled ? " disabled" : ""}${runPending ? ' aria-busy="true"' : ""}>${runPending ? "Starting…" : "Run again"}</button>` : ""}</div></div>
    <p class="automation-feedback" role="status" aria-live="polite" data-tone="${snapshot.error ? "error" : ""}">${escapeHtml(snapshot.error || snapshot.feedback || (run ? "Run details loaded." : "Open a run to see its timeline and report."))}</p>
    ${locked ? "" : `<div class="automation-tabs" role="tablist"><button type="button" role="tab" aria-selected="false" data-action="editor">Editor</button><button type="button" role="tab" aria-selected="true">Runs</button></div>${renderAutomationRunHistory(snapshot)}`}
    ${run ? `${renderAutomationReport(run)}
      <div class="automation-run-explorer">${renderAutomationRunSteps(run, snapshot.selectedNodeId, detailId)}
      ${selectedNode ? `<section class="automation-run-detail" id="${escapeHtml(detailId)}" data-selected-step-result tabindex="-1" aria-label="Selected step result">
        ${renderAutomationStepEvidence(snapshot)}
        <details data-disclosure-id="step-configuration-${escapeHtml(selectedNode.id)}"><summary>Step configuration</summary>${renderAutomationNodeDetails(selectedNode, run)}</details></section>` : `<p class="automation-run-step-hint">Choose a step to explore its saved result.</p>`}</div>
      <details class="automation-run-workflow" data-disclosure-id="run-workflow"><summary>Workflow diagram</summary>
        <section class="automation-canvas" aria-label="Run timeline">${run.definition ? renderAutomationTimeline(run.definition, { run, selectedNodeId: snapshot.selectedNodeId }) : `<p class="automation-empty-graph">The frozen graph is unavailable for this run.</p>`}</section></details>` : ""}
  </div>`;
}
