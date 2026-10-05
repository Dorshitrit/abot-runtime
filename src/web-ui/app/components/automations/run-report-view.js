import { escapeHtml, formatTime } from "../../lib/text-format.js";
import { renderAutomationSavedOutput } from "./run-output-view.js";
import { automationFailurePresentation, automationRunFailureCause, renderAutomationFailure, renderAutomationRunFailure } from "./failure-presentation.js";

function measured(value) {
  return Number.isFinite(value) ? String(value) : "Not measured";
}

const OUTCOME_LABELS = {
  succeeded: "Completed", completed_with_skips: "Completed with skips",
  failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", missed: "Missed",
  rejected: "Rejected", uncertain: "Uncertain", pending: "Pending",
};

function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] || String(outcome || "Unknown").replaceAll("_", " ");
}

function duration(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const finish = Date.parse(finishedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return "Not measured";
  const seconds = Math.floor((finish - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stepCounts(results) {
  const counts = new Map();
  for (const result of results) counts.set(result.status, (counts.get(result.status) || 0) + 1);
  return ["succeeded", "skipped", "failed", "cancelled", "interrupted"]
    .filter((status) => counts.has(status))
    .map((status) => `<span><strong>${counts.get(status)}</strong> ${escapeHtml(outcomeLabel(status).toLowerCase())}</span>`)
    .join("");
}

function rawAction(action) {
  return `<li><code>${escapeHtml(action.type)}</code>${action.target ? ` · <span dir="auto">${escapeHtml(action.target)}</span>` : ""}</li>`;
}

function diagnostics(report, run) {
  const results = Array.isArray(report.nodeResults) ? report.nodeResults : [];
  const uncertain = Array.isArray(report.uncertainEffects) ? report.uncertainEffects : [];
  const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
  const effects = Array.isArray(report.effectSummary?.entries) ? report.effectSummary.entries : [];
  return `<details class="automation-run-diagnostics" data-disclosure-id="run-diagnostics"><summary>Diagnostics</summary>
    <dl><dt>Run ID</dt><dd><code>${escapeHtml(run.id)}</code></dd>
      <dt>Revision</dt><dd>${escapeHtml(report.definitionRevision ?? run.definitionRevision ?? "Unavailable")}</dd>
      ${run.error ? `<dt>Run error</dt><dd><code>${escapeHtml(run.error)}</code></dd>` : ""}</dl>
    ${results.length ? `<h5>Step records</h5><ul>${results.map((item) => `<li>${escapeHtml(item.title || item.nodeId)} · <code>${escapeHtml(item.nodeId)}</code> · ${escapeHtml(item.status)}${item.errorCode ? ` · <code>${escapeHtml(item.errorCode)}</code>` : ""}${item.resultRef ? ` · result <code>${escapeHtml(item.resultRef)}</code>` : ""}</li>`).join("")}</ul>` : ""}
    ${effects.length ? `<h5>Tool receipts</h5><ul>${effects.map((item) => `<li><code>${escapeHtml(item.attemptId)}</code> · ${escapeHtml(item.operation?.toolName || "Tool")} / ${escapeHtml(item.operation?.operationId || "Unknown operation")} · ${escapeHtml(item.outcome)}${item.effect ? ` · ${escapeHtml(item.effect)}` : ""}${item.errorCode ? ` · <code>${escapeHtml(item.errorCode)}</code>` : ""}${item.actions?.length ? `<ul>${item.actions.map(rawAction).join("")}</ul>` : ""}</li>`).join("")}</ul>` : ""}
    ${uncertain.length ? `<h5>Uncertain attempts</h5><ul>${uncertain.map((item) => `<li><code>${escapeHtml(item.nodeId)}</code> · <code>${escapeHtml(item.attemptId)}</code></li>`).join("")}</ul>` : ""}
    ${artifacts.length ? `<h5>Saved artifact records</h5><ul>${artifacts.map((item) => `<li>${escapeHtml(item.kind)} · <code>${escapeHtml(item.id)}</code></li>`).join("")}</ul>` : ""}
  </details>`;
}

function isConfirmedFileWrite(action, outcome, effect) {
  return outcome === "succeeded" && action.type === "write_file" &&
    (effect === "mutating" || effect === "mixed");
}

function targetLabel(action, outcome, effect) {
  if (isConfirmedFileWrite(action, outcome, effect)) return "Saved file";
  if (outcome !== "succeeded") return "Receipt target · not confirmed";
  return "Recorded target";
}

function recordedTarget(action, outcome, effect) {
  if (!action.target) return "";
  const label = targetLabel(action, outcome, effect);
  return `<li><span>${label}</span><strong dir="auto">${escapeHtml(action.target)}</strong></li>`;
}

function renderReportEffects(report, run) {
  const summary = report.effectSummary;
  const late = Array.isArray(report.lateEvidence) ? report.lateEvidence : [];
  const lateNotice = late.length
    ? `<p class="automation-report-warning">Later evidence arrived for ${late.length} uncertain attempt${late.length === 1 ? "" : "s"}; it does not change the original run outcome.</p>`
    : "";
  if (!summary) return `<section class="automation-report-outputs"><h5>Recorded output targets</h5><p>Verified effect details were not retained in this report.${run.detailsExpiredAt ? " The original step records have expired." : " Select a step to inspect any retained evidence."}</p>${lateNotice}</section>`;
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  const actions = entries.flatMap((entry) => entry.outcome === "succeeded"
    ? (Array.isArray(entry.actions) ? entry.actions.map((action) => ({ action, effect: entry.effect })) : []) : []);
  const targets = actions.map(({ action, effect }) => recordedTarget(action, "succeeded", effect)).filter(Boolean);
  const omittedActions = entries.reduce((total, entry) => total + (entry.omittedActions || 0), 0);
  const partial = summary.omitted > 0 || omittedActions > 0;
  const omitted = [
    summary.omitted > 0 ? `${summary.omitted} further effect record${summary.omitted === 1 ? "" : "s"}` : "",
    omittedActions > 0 ? `${omittedActions} action${omittedActions === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  return `<section class="automation-report-outputs" aria-label="Recorded output targets"><h5>Recorded output targets</h5>
    ${targets.length ? `<ul class="automation-recorded-targets">${targets.join("")}</ul>` : `<p>No confirmed output target was recorded${partial ? " in the displayed entries" : ""}.</p>`}
    <p class="automation-report-effect-meta">${escapeHtml(summary.verifiedExecutions)} verified tool execution${summary.verifiedExecutions === 1 ? "" : "s"} · ${escapeHtml(actions.length)} confirmed completion action${actions.length === 1 ? "" : "s"}</p>
    ${summary.unresolvedAttempts ? `<p class="automation-report-warning">${escapeHtml(summary.unresolvedAttempts)} unresolved tool attempt${summary.unresolvedAttempts === 1 ? "" : "s"}; its outcome is not confirmed.</p>` : ""}
    ${partial ? `<p class="automation-report-warning">${escapeHtml(omitted)} omitted from this compact view.</p>` : ""}
    ${lateNotice}</section>`;
}

function renderRunResults(run) {
  const summary = run.outputSummary;
  const entries = Array.isArray(summary?.entries) ? summary.entries : [];
  const title = entries.length > 1 ? "Saved results" : "Saved result";
  const fallback = run.detailsExpiredAt
    ? "The saved step outputs have expired. The compact run report is still available."
    : "No final-step output is available here. Select a step below to inspect any retained result.";
  return `<section class="automation-report-results" aria-label="Saved results"><h4>${title}</h4>
    ${entries.length ? entries.map((entry) => {
      const hasSavedOutput = entry.availability === "available" && Boolean(entry.output);
      const unavailable = entry.availability === "expired"
        ? "This saved result has expired."
        : "No saved output is available for this step.";
      return `<article class="automation-report-result"><header class="automation-result-heading"><h5 dir="auto">${escapeHtml(entry.title || "Final step")}</h5>
        <span class="automation-result-status" data-outcome="${escapeHtml(entry.stepStatus)}">${escapeHtml(outcomeLabel(entry.stepStatus))}</span></header>
        ${hasSavedOutput ? renderAutomationSavedOutput(entry.output, { disclosureId: `run-result-${entry.nodeId}` }) : `<p class="automation-output-notice">${unavailable}</p>`}
        <footer class="automation-result-footer"><button type="button" data-automation-node="${escapeHtml(entry.nodeId)}">Inspect step</button>
          ${entry.errorCode ? `<span class="automation-report-warning">${escapeHtml(automationFailurePresentation(entry.errorCode, run).title)}</span>` : ""}</footer></article>`;
    }).join("") : `<p class="automation-output-notice">${fallback}</p>`}
    ${summary?.omitted > 0 ? `<p class="automation-output-notice">${escapeHtml(summary.omitted)} further final-step result${summary.omitted === 1 ? " is" : "s are"} not shown here. Select a step to inspect its result.</p>` : ""}
  </section>`;
}

function executionDetails(report, run, results, inputs) {
  return `<details class="automation-report-execution" data-disclosure-id="run-execution"><summary>Execution details</summary>
    <div class="automation-report-stats" aria-label="Run measures">
      <div><span>Duration</span><strong>${duration(report.startedAt || run.startedAt, report.finishedAt || run.finishedAt)}</strong></div>
      <div><span>Steps</span><strong>${results.length ? escapeHtml(results.length) : "Not recorded"}</strong></div>
      <div><span>Tool calls</span><strong>${measured(report.toolCalls)}</strong><small class="automation-muted">Verified executions</small></div>
      <div><span>Model calls</span><strong>${measured(report.modelCalls)}</strong><small class="automation-muted">All admitted model invocations</small></div>
      <div><span>Tool attempts admitted</span><strong>${measured(report.toolAttempts)}</strong><small class="automation-muted">Counted against the tool limit</small></div></div>
    <div class="automation-report-counts" aria-label="Step counts">${stepCounts(results) || "No step results recorded"}</div>
    <div class="automation-report-times"><span>Started · ${escapeHtml(formatTime(report.startedAt || run.startedAt) || "Unavailable")}</span>
      <span>Finished · ${escapeHtml(formatTime(report.finishedAt || run.finishedAt) || "Unavailable")}</span></div>
    ${inputs.length ? `<details data-disclosure-id="run-selected-files"><summary>Selected files (${inputs.length})</summary><ul>${inputs.map((item) => `<li><span dir="auto">${escapeHtml(item.canonicalPath || item.inputId)}</span></li>`).join("")}</ul></details>` : ""}
    ${diagnostics(report, run)}</details>`;
}

export function renderAutomationReport(run) {
  const report = run.report;
  if (!report) {
    const message = run.reportState === "expired" ? "The saved report has expired." :
      ["pending", "running", "stopping"].includes(run.status)
        ? "The report will appear when this run finishes." : "The saved report is unavailable.";
    const failureCode = automationRunFailureCause(run)?.error;
    return `<section class="automation-run-report" aria-label="Run report"><h4>Run report</h4>${renderAutomationRunFailure(run)}<p>${message}</p>
      ${failureCode ? `<details class="automation-run-diagnostics" data-disclosure-id="run-diagnostics"><summary>Diagnostics</summary><code>${escapeHtml(failureCode)}</code></details>` : ""}</section>`;
  }
  const results = Array.isArray(report.nodeResults) ? report.nodeResults : [];
  const inputs = Array.isArray(report.inputVersions) ? report.inputVersions : [];
  const outcome = report.outcome || run.status;
  return `<section class="automation-run-report" aria-label="Saved run report">
    <div class="automation-report-heading"><div class="automation-report-title"><div class="automation-report-title-line"><h4>Run report</h4><span class="automation-report-status" data-outcome="${escapeHtml(outcome)}">Execution · ${escapeHtml(outcomeLabel(outcome))}</span></div>
      ${run.definition?.objective ? `<p dir="auto" class="automation-report-goal">${escapeHtml(run.definition.objective)}</p>` : ""}</div></div>
    ${renderAutomationRunFailure(run)}
    ${renderRunResults(run)}
    ${renderReportEffects(report, run)}
    ${executionDetails(report, run, results, inputs)}
  </section>`;
}

function renderInputs(inputs) {
  if (!inputs.length) return `<p>No input bindings configured for this step.</p>`;
  return `<p class="automation-input-notice">Values below are reconstructed from the frozen definition and saved producer records. The exact materialized step input was not stored separately.</p>
    <ul class="automation-step-inputs">${inputs.map((item, index) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.source)}</span>
      ${item.status === "unavailable" ? `<small>Value unavailable</small>` : `<small>${item.status === "metadata" ? "Selected file metadata" : "Reconstructed value"}</small>${item.preview ? renderAutomationSavedOutput({ text: item.preview, full: false }, { disclosureId: `step-input-${index}` }) : ""}`}</li>`).join("")}</ul>`;
}

function missingOutputMessage(evidence) {
  if (evidence.savedOutcome?.kind === "rejected")
    return `Tool invocation was rejected before output was saved${evidence.savedOutcome.errorCode ? ` · ${escapeHtml(evidence.savedOutcome.errorCode)}` : ""}.`;
  if (evidence.savedOutcome?.kind === "uncertain")
    return `The tool outcome is uncertain${evidence.savedOutcome.errorCode ? ` · ${escapeHtml(evidence.savedOutcome.errorCode)}` : ""}; no output was saved.`;
  if (evidence.stepStatus === "running" || evidence.stepStatus === "pending")
    return "No output saved yet.";
  return "No output was saved for this step.";
}

function renderEffects(effects) {
  if (!effects.length) return `<p>No tool attempt was recorded for this step.</p>`;
  return `<ul class="automation-step-effects">${effects.map((item) => {
    const operation = item.operation?.operationId
      ? item.operation.operationId.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase())
      : "Tool attempt";
    const actions = Array.isArray(item.actions) ? item.actions : [];
    const targets = actions.map((action) => recordedTarget(action, item.outcome, item.effect)).filter(Boolean);
    return `<li><div class="automation-effect-heading"><strong>${escapeHtml(operation)}</strong><span data-outcome="${escapeHtml(item.outcome)}">${escapeHtml(outcomeLabel(item.outcome))}</span></div>
      ${targets.length ? `<ul class="automation-recorded-targets">${targets.join("")}</ul>` : ""}
      ${item.errorCode ? `<p class="automation-report-warning">${escapeHtml(outcomeLabel(item.outcome))} · ${escapeHtml(item.errorCode)}</p>` : ""}
      ${item.omittedActions ? `<p class="automation-report-warning">${item.omittedActions} further action${item.omittedActions === 1 ? "" : "s"} omitted from this view.</p>` : ""}
      ${item.lateEvidence ? `<p class="automation-report-warning">Later evidence: ${escapeHtml(outcomeLabel(item.lateEvidence.status))}; original outcome remains ${escapeHtml(outcomeLabel(item.outcome))}.</p>` : ""}
      <details class="automation-effect-diagnostics" data-disclosure-id="effect-${escapeHtml(item.attemptId)}"><summary>Technical details</summary><dl>
        <dt>Tool</dt><dd>${escapeHtml(item.operation?.toolName || "Unavailable")}</dd>
        <dt>Operation</dt><dd>${escapeHtml(item.operation?.operationId || "Unavailable")}</dd>
        <dt>Attempt</dt><dd><code>${escapeHtml(item.attemptId || "Unavailable")}</code></dd>
        <dt>Effect</dt><dd>${escapeHtml(item.effect || "Unavailable")}</dd></dl>
        ${actions.length ? `<ul>${actions.map(rawAction).join("")}</ul>` : ""}</details></li>`;
  }).join("")}</ul>`;
}

export function renderAutomationStepEvidence(snapshot) {
  if (!snapshot.selectedNodeId) return "";
  const evidence = snapshot.stepEvidence;
  const matching = evidence?.runId === snapshot.run?.id &&
    evidence?.nodeId === snapshot.selectedNodeId;
  if (snapshot.stepEvidenceLoading && !matching)
    return `<section class="automation-step-evidence" aria-label="Step evidence"><h4>Step result</h4><p>Loading saved evidence…</p></section>`;
  if (snapshot.stepEvidenceError && !matching)
    return `<section class="automation-step-evidence" aria-label="Step evidence"><h4>Step result</h4><p role="alert">${escapeHtml(snapshot.stepEvidenceError)}</p></section>`;
  if (!matching) return "";
  if (evidence.availability === "expired")
    return `<section class="automation-step-evidence" aria-label="Step evidence"><h4>Step result</h4><p>The detailed inputs, output, and effects for this run have expired. The compact run report remains available while retained.</p></section>`;
  const output = evidence.output;
  const record = snapshot.run?.nodes?.find((item) => item.nodeId === evidence.nodeId)
    || snapshot.run?.report?.nodeResults?.find((item) => item.nodeId === evidence.nodeId);
  return `<section class="automation-step-evidence" aria-label="Step evidence"><h4>Step result · ${escapeHtml(evidence.title || "Selected step")}</h4>
    ${snapshot.stepEvidenceError ? `<p role="alert">${escapeHtml(snapshot.stepEvidenceError)}</p>` : ""}
    ${renderAutomationFailure(record?.errorCode, snapshot.run)}
    ${output ? renderAutomationSavedOutput(output, { disclosureId: `step-output-${evidence.nodeId}`, showFullButton: true }) : `<p>${missingOutputMessage(evidence)}</p>`}
    ${record?.errorCode ? `<details class="automation-step-disclosure" data-disclosure-id="step-error-${escapeHtml(evidence.nodeId)}"><summary>Technical error</summary><code>${escapeHtml(record.errorCode)}</code></details>` : ""}
    <details class="automation-step-disclosure" data-disclosure-id="step-effects-${escapeHtml(evidence.nodeId)}"><summary>Tool effects (${Array.isArray(evidence.effects) ? evidence.effects.length : 0})</summary>${renderEffects(Array.isArray(evidence.effects) ? evidence.effects : [])}</details>
    <details class="automation-step-disclosure" data-disclosure-id="step-inputs-${escapeHtml(evidence.nodeId)}"><summary>Configured inputs</summary>${renderInputs(Array.isArray(evidence.inputs) ? evidence.inputs : [])}</details>
  </section>`;
}
