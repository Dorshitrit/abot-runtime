import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { automationFailurePresentation, renderAutomationFailure, renderAutomationRunFailure } from "../../web-ui/app/components/automations/failure-presentation.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationReport, renderAutomationStepEvidence } from "../../web-ui/app/components/automations/run-report-view.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationNodeDetails } from "../../web-ui/app/components/automations/timeline.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditor } from "../../web-ui/app/components/automations/editor.js";

const node = { kind: "agent", id: "agent-1", title: "Classify input", prompt: "Classify",
  modelProfileId: "local", agentMode: "fast", onFailure: "stop", inputs: {}, tools: [] };
const definition = { schemaVersion: 1, automationId: "automation-1", revision: 3,
  title: "Classify tickets", objective: "Save matching content and archive inputs", inputs: {},
  trigger: { kind: "manual" }, limits: { maxModelCallsPerRun: 2, maxToolCallsPerRun: 4,
    maxRunDurationMs: 300_000, maxConcurrentNodes: 1, maxRunsPerDay: 24,
    maxStoredArtifactBytes: 1_048_576, stopReportDeadlineMs: 30_000 },
  body: { kind: "sequence", id: "root", children: [node] } };
const run = { id: "run-1", automationId: "automation-1", status: "failed", definition,
  nodes: [{ nodeId: node.id, status: "failed", errorCode: "automation_model_call_limit_reached" }],
  error: "automation_model_call_limit_reached",
  report: { outcome: "failed", definitionRevision: 3, startedAt: "2026-09-30T10:00:00Z",
    finishedAt: "2026-09-30T10:00:30Z", modelCalls: 2, toolCalls: 0, toolAttempts: 4,
    nodeResults: [{ nodeId: node.id, title: node.title, status: "failed",
      errorCode: "automation_model_call_limit_reached" }],
    inputVersions: [], uncertainEffects: [], lateEvidence: [], artifacts: [] } };

describe("Automation failure presentation", () => {
  test("leads with the recorded cause, usage and published limit before saved output", () => {
    const markup = renderAutomationReport(run);
    expect(markup).toContain("Model call limit reached");
    expect(markup).toContain("Model calls admitted: 2 · Published limit: 2");
    expect(markup).toContain("Tool calls</span><strong>0</strong>");
    expect(markup).toContain("Verified executions");
    expect(markup).toContain("Tool attempts admitted</span><strong>4</strong>");
    expect(markup).toContain("save the draft and publish");
    expect(markup.indexOf('aria-label="Failure reason"'))
      .toBeLessThan(markup.indexOf('aria-label="Saved results"'));
    expect(markup.indexOf("<code>automation_model_call_limit_reached</code>"))
      .toBeGreaterThan(markup.indexOf("<summary>Diagnostics</summary>"));
  });

  test("counts admitted tool attempts independently of verified tool executions", () => {
    const presentation = automationFailurePresentation("automation_tool_call_limit_reached", run);
    expect(presentation.usage).toBe("Tool attempts admitted: 4 · Published limit: 4");
    const historical = { ...run, report: { ...run.report, toolAttempts: undefined } };
    expect(automationFailurePresentation("automation_tool_call_limit_reached", historical).usage)
      .toBe("Tool attempts admitted: Not recorded · Published limit: 4");
  });

  test("does not infer an exact resource cause from historical generic budget records", () => {
    const presentation = automationFailurePresentation("automation_budget_exhausted", run);
    expect(presentation.title).toBe("Resource limit reached");
    expect(presentation.reason).toContain("does not identify which limit");
    expect(presentation.usage).toBe("");
  });

  test.each(["automation_agent_acceptance_failed", "automation_source_changed",
    "automation_operation_unavailable", "automation_artifact_budget_exhausted"])
  ("normalizes historical Error prefix without changing the cause for %s", (code) => {
    expect(automationFailurePresentation(`Error: ${code}`, run))
      .toEqual(automationFailurePresentation(code, run));
  });

  test("uses the same failure projection for the selected result and step configuration", () => {
    const evidence = { runId: run.id, nodeId: node.id, title: node.title,
      availability: "available", stepStatus: "failed", output: null, inputs: [], effects: [] };
    const shared = renderAutomationFailure(run.error, run);
    const result = renderAutomationStepEvidence({ run, selectedNodeId: node.id, stepEvidence: evidence });
    const details = renderAutomationNodeDetails(node, run);
    expect(result).toContain(shared);
    expect(details).toContain(shared);
    expect(result).toContain("Technical error");
    expect(details).toContain("Technical error");
  });

  test("keeps root failures visible when reports are missing or expired", () => {
    const markup = renderAutomationReport({ ...run, report: null, reportState: "expired" });
    expect(markup).toContain('aria-label="Failure reason"');
    expect(markup).toContain("Model calls admitted: Not recorded · Published limit: 2");
    expect(markup).toContain("The saved report has expired.");
    expect(markup.indexOf("<code>automation_model_call_limit_reached</code>"))
      .toBeGreaterThan(markup.indexOf("<summary>Diagnostics</summary>"));
  });

  test.each(["report", "nodes"])("presents an elapsed stop deadline as a run-wide cause from %s", (source) => {
    const code = "Error: automation_stop_deadline_elapsed";
    const records = [
      { nodeId: "optional", title: "Optional rejected result", status: "skipped", errorCode: "automation_agent_acceptance_failed" },
      { nodeId: "mutating", title: "Uncertain write", status: "interrupted", errorCode: "automation_effect_uncertain" },
      { nodeId: "pending", title: "Cancelled pending work", status: "cancelled", errorCode: "automation_run_stopped" },
    ];
    const stopped = { ...run, status: "cancelled", error: code, nodes: records,
      report: source === "report" ? { ...run.report, outcome: "cancelled", nodeResults: records } : null };
    const presentation = automationFailurePresentation(code, stopped);
    expect(presentation.scope).toBe("run");
    expect(presentation.title).not.toBe(automationFailurePresentation("unknown_error").title);
    expect(presentation.reason).toMatch(/stop.*deadline/i);
    const markup = renderAutomationReport(stopped);
    expect(markup).toContain(renderAutomationFailure(code, stopped));
    expect(markup).not.toContain('class="automation-failure-step"');
    expect(markup.indexOf(`<code>${code}</code>`))
      .toBeGreaterThan(markup.indexOf("<summary>Diagnostics</summary>"));
  });

  test.each([
    ["cancelled", "Error: automation_run_stopped", "cancelled"],
    ["interrupted", "Error: automation_effect_uncertain", "interrupted"],
    ["failed", "automation_model_call_limit_reached", "failed"],
    ["completed_with_skips", "automation_source_changed", "skipped"],
  ])("aligns the missing-report diagnostic with the selected %s cause", (outcome, errorCode, status) => {
    const records = [
      { nodeId: "optional", status: "skipped", errorCode: "automation_agent_acceptance_failed" },
      { nodeId: "pending", status: "cancelled", errorCode: "automation_run_stopped" },
      { nodeId: "cause", status, errorCode },
    ];
    const candidates = records.filter((record) =>
      !(outcome === "completed_with_skips" && record.nodeId === "optional") &&
      !(outcome === "cancelled" && record.nodeId === "pending"));
    const missing = { ...run, status: outcome, error: "", nodes: candidates, report: null };
    const markup = renderAutomationReport(missing);
    const diagnostics = markup.slice(markup.indexOf('<details class="automation-run-diagnostics"'));
    expect(markup).toContain(renderAutomationFailure(errorCode, missing));
    expect(diagnostics).toContain(`<code>${errorCode}</code>`);
    expect(diagnostics).not.toContain("automation_agent_acceptance_failed");
    if (outcome === "interrupted") expect(diagnostics).not.toContain("automation_run_stopped");
  });

  test.each(["failed", "cancelled", "interrupted", "running", "succeeded"])
  ("does not fabricate a missing-report diagnostic cause for %s from unrelated skipped work", (outcome) => {
    const markup = renderAutomationReport({ ...run, status: outcome, error: "", report: null,
      nodes: [{ nodeId: "optional", status: "skipped", errorCode: "automation_agent_acceptance_failed" }] });
    expect(markup).not.toContain('<details class="automation-run-diagnostics"');
    expect(markup).not.toContain("automation_failure_cause_not_recorded");
    expect(markup).not.toContain("Agent result did not meet the step conditions");
    expect(markup.includes('aria-label="Failure reason"'))
      .toBe(["failed", "cancelled", "interrupted"].includes(outcome));
  });

  test("does not invent usage when counters or published limits were not retained", () => {
    expect(automationFailurePresentation(run.error, { definition: {} }).usage)
      .toBe("Model calls admitted: Not recorded");
    expect(automationFailurePresentation(run.error, { ...run, report: { modelCalls: 0 } }).usage)
      .toBe("Model calls admitted: 0 · Published limit: 2");
  });

  test("distinguishes request timeouts, whole-run duration, blocked work and rejected output", () => {
    const timeout = automationFailurePresentation("worker_capability_payload_timeout", run);
    const duration = automationFailurePresentation("automation_run_duration_exceeded", run);
    expect(timeout.title).toBe("Tool input preparation timed out");
    expect(timeout.usage).toBe("");
    expect(duration.title).toBe("Run duration limit reached");
    expect(duration.usage).toBe("Published run duration limit: 300 seconds");
    expect(automationFailurePresentation("automation_agent_blocked").title)
      .not.toBe(automationFailurePresentation("automation_agent_acceptance_failed").title);
  });

  test("only recognizes exact known request timeout and invalid-response codes", () => {
    expect(automationFailurePresentation("execution_agent_decision_timeout", run).title)
      .toBe("Agent decision timed out");
    expect(automationFailurePresentation("worker_capability_payload_model_output_invalid", run).title)
      .toBe("The model response did not match the required format");
    expect(automationFailurePresentation("private_operation_timeout", run).reason)
      .toBe("This view cannot explain the recorded error.");
  });

  test.each(["request_inactivity_timeout", "llm_stream_inactivity_timeout"])
  ("distinguishes inactivity from a total request deadline for %s", (code) => {
    const presentation = automationFailurePresentation(code, run);
    expect(presentation.reason).toContain("inactivity interval");
    expect(presentation.reason).not.toContain("did not finish before");
    expect(presentation.usage).toBe("");
    expect(presentation.title).not.toBe(automationFailurePresentation("request_timeout").title);
  });

  test("associates the root failure only with a failed step carrying the same normalized cause", () => {
    const records = [
      { nodeId: "earlier", title: "Earlier failure", status: "failed", errorCode: "automation_agent_acceptance_failed" },
      { nodeId: node.id, title: "Actual limiting step", status: "failed", errorCode: "Error: automation_model_call_limit_reached" },
    ];
    const markup = renderAutomationRunFailure({ ...run, report: { ...run.report, nodeResults: records } });
    expect(markup).toContain("Actual limiting step");
    expect(markup).not.toContain("Earlier failure");
    const rootOnly = renderAutomationRunFailure({ ...run, error: "automation_agent_provider_failed",
      report: { ...run.report, nodeResults: records } });
    expect(rootOnly).toContain("Model provider request failed");
    expect(rootOnly).not.toContain('class="automation-failure-step"');
  });

  test.each(["automation_run_duration_exceeded", "automation_run_deadline_elapsed",
    "automation_budget_exhausted", "automation_run_stopped"])
  ("does not attribute run-wide %s to an incidental step", (code) => {
    const markup = renderAutomationRunFailure({ ...run, error: code,
      report: { ...run.report, nodeResults: [
        { nodeId: "earlier", title: "Earlier skipped work", status: "skipped", errorCode: "automation_agent_acceptance_failed" },
        { nodeId: node.id, title: "Interrupted work", status: "failed", errorCode: code },
      ] } });
    expect(markup).toContain(automationFailurePresentation(code).title);
    expect(markup).not.toContain('class="automation-failure-step"');
    const nodeOnly = renderAutomationRunFailure({ ...run, error: "",
      report: { ...run.report, nodeResults: [{ nodeId: node.id, title: "Interrupted work",
        status: "failed", errorCode: code }] } });
    expect(nodeOnly).toContain(automationFailurePresentation(code).title);
    expect(nodeOnly).not.toContain('class="automation-failure-step"');
  });

  test.each([
    ["report", ""], ["report", "Error: "], ["nodes", ""], ["nodes", "Error: "],
  ])("uses the cancelled receipt instead of earlier skipped work from %s with prefix %j", (source, prefix) => {
    const records = [
      { nodeId: "optional", title: "Optional rejected result", status: "skipped", errorCode: "automation_agent_acceptance_failed" },
      { nodeId: "stopped", title: "Work interrupted by stop", status: "cancelled", errorCode: `${prefix}automation_run_stopped` },
    ];
    const markup = renderAutomationRunFailure({ ...run, status: "cancelled", error: "", nodes: records,
      report: source === "report" ? { ...run.report, outcome: "cancelled", nodeResults: records } : null });
    expect(markup).toContain("Run stopped");
    expect(markup).not.toContain("Optional rejected result");
    expect(markup).not.toContain("Agent result did not meet the step conditions");
    expect(markup).not.toContain('class="automation-failure-step"');
  });

  test.each(["failed", "cancelled", "interrupted"])
  ("retains known interrupted uncertainty ahead of skipped and ordinary stopped work for %s", (outcome) => {
    const records = [
      { nodeId: "optional", title: "Optional rejected result", status: "skipped", errorCode: "automation_agent_acceptance_failed" },
      { nodeId: "pending", title: "Cancelled pending work", status: "cancelled", errorCode: "automation_run_stopped" },
      { nodeId: "mutating", title: "Uncertain write", status: "interrupted", errorCode: "Error: automation_effect_uncertain" },
    ];
    const markup = renderAutomationRunFailure({ ...run, status: outcome, error: "",
      report: { ...run.report, outcome, nodeResults: records } });
    expect(markup).toContain("A tool's outcome is uncertain");
    expect(markup).toContain("Uncertain write");
    expect(markup).not.toContain("Optional rejected result");
    expect(markup).not.toContain("Run stopped");
  });

  test.each(["failed", "cancelled", "interrupted"])
  ("does not invent a %s cause from an unrelated skipped failure", (outcome) => {
    const markup = renderAutomationRunFailure({ ...run, status: outcome, error: "",
      report: { ...run.report, outcome, nodeResults: [{ nodeId: "optional", title: "Optional result",
        status: "skipped", errorCode: "automation_agent_acceptance_failed" }] } });
    expect(markup).toContain("This view cannot explain the recorded error.");
    expect(markup).not.toContain("Agent result did not meet the step conditions");
    expect(markup).not.toContain("Optional result");
  });

  test("retains the optional-step explanation for completed_with_skips", () => {
    const markup = renderAutomationRunFailure({ ...run, status: "completed_with_skips", error: "",
      report: { ...run.report, outcome: "completed_with_skips", nodeResults: [{ nodeId: "optional",
        title: "Optional result", status: "skipped", errorCode: "automation_agent_acceptance_failed" }] } });
    expect(markup).toContain("Agent result did not meet the step conditions");
    expect(markup).toContain("Optional result");
  });

  test("keeps the explicit root cause primary over interrupted or cancelled fallback candidates", () => {
    const markup = renderAutomationRunFailure({ ...run, status: "cancelled", error: "automation_run_stopped",
      report: { ...run.report, outcome: "cancelled", nodeResults: [
        { nodeId: "mutating", status: "interrupted", errorCode: "automation_effect_uncertain" },
        { nodeId: "pending", status: "cancelled", errorCode: "automation_run_stopped" },
      ] } });
    expect(markup).toContain("Run stopped");
    expect(markup).not.toContain("A tool's outcome is uncertain");
  });

  test("classifies invalid degraded-finalization output as a rejected model format", () => {
    const presentation = automationFailurePresentation("invalid_degraded_finalization_output", run);
    expect(presentation.title).toBe("The model response did not match the required format");
    expect(presentation.reason).not.toContain("cannot explain");
    expect(renderAutomationRunFailure({ ...run, error: "invalid_degraded_finalization_output" }))
      .toContain("The model response did not match the required format");
  });

  test.each(["provider private response <script>bad</script>", "constructor", "__proto__"])
  ("provides an honest generic explanation for unknown failure %s", (code) => {
    const presentation = automationFailurePresentation(code, run);
    expect(presentation.reason).toBe("This view cannot explain the recorded error.");
    expect(presentation.usage).toBe("");
    expect(renderAutomationFailure(code, run)).not.toContain(code);
  });

  test("shows absent failure evidence explicitly and omits failure banners for successful runs", () => {
    expect(renderAutomationReport({ ...run, error: "", nodes: [],
      report: { ...run.report, nodeResults: [] } }))
      .toContain("This view cannot explain the recorded error.");
    expect(renderAutomationReport({ ...run, status: "succeeded", error: "",
      report: { ...run.report, outcome: "succeeded" } }))
      .not.toContain('aria-label="Failure reason"');
  });

  test("escapes step titles without altering the recorded failure meaning", () => {
    const markup = renderAutomationReport({ ...run,
      report: { ...run.report, nodeResults: [{ ...run.report.nodeResults[0], title: "<script>bad</script>" }] } });
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  test("explains what model limits count and preserves the user's selected values", () => {
    const markup = renderAutomationEditor({ automations: [], selectedAutomationId: definition.automationId,
      selectedNodeId: "", runs: [], draft: { revision: 3, definition },
      catalog: { operations: [], models: [], savedAgents: [] }, grant: null,
      validation: null, error: "", feedback: "" });
    expect(markup).toContain('name="limit-maxModelCallsPerRun" value="2" aria-describedby="automation-model-limit-help"');
    expect(markup).toContain('id="automation-model-limit-help"');
    expect(markup).toContain("decisions, tool discovery, input preparation and final responses");
    expect(markup).toContain("ceiling, not the desired number of calls");
    expect(markup).toContain("Save the draft and publish");
  });
});
