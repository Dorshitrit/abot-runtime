import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRun } from "../../web-ui/app/components/automations/run.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationReport } from "../../web-ui/app/components/automations/run-report-view.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";

const definition = {
  schemaVersion: 1, automationId: "auto-1", revision: 2, title: "News workflow",
  objective: "Write a dated report", trigger: { kind: "manual" }, inputs: {},
  body: { kind: "sequence", id: "root", children: [{
    kind: "tool", id: "write", title: "Store report", onFailure: "stop",
    operation: { toolName: "filesystem", operationId: "write", contractVersion: 1 },
    controls: {},
  }] },
};
const run = {
  id: "private-run-id", automationId: "auto-1", status: "succeeded",
  definitionRevision: 2, definition, nodes: [{ nodeId: "write", status: "succeeded" }],
  report: {
    outcome: "succeeded", definitionRevision: 2, startedAt: "2026-09-29T10:00:00Z",
    finishedAt: "2026-09-29T10:01:00Z", nodeResults: [{ nodeId: "write", title: "Store report",
      status: "succeeded", resultRef: "private-result-id" }],
    inputVersions: [], uncertainEffects: [], lateEvidence: [], artifacts: [],
    modelCalls: 0, toolCalls: 1,
    effectSummary: {
      total: 1, omitted: 0, verifiedExecutions: 1, unresolvedAttempts: 0,
      entries: [{ attemptId: "attempt-1", nodeId: "write", outcome: "succeeded",
        effect: "mutating", actions: [{ type: "write_file", target: "/work/report-2026-09-29.txt" }],
        omittedActions: 0 }],
    },
  },
};

describe("ABot Studio run evidence view", () => {
  it("leads with the saved final-step result, independently of execution status and receipt actions", () => {
    const value = JSON.stringify({ published: false, reason: "No current source was verified." });
    const markup = renderAutomationReport({ ...run, outputSummary: { entries: [{
      nodeId: "write", title: "Editorial result", stepStatus: "succeeded", availability: "available",
      output: { data: { value, truncated: false, totalCharacters: value.length }, full: false },
    }], omitted: 0 } });
    expect(markup).toContain("Execution · Completed");
    expect(markup).toContain("Editorial result");
    expect(markup).toContain("No current source was verified.");
    expect(markup).toContain('data-value-type="boolean">false');
    expect(markup).toContain('data-automation-node="write">Inspect step');
    expect(markup.indexOf("No current source was verified."))
      .toBeLessThan(markup.indexOf('aria-label="Recorded output targets"'));
    expect(markup.indexOf('aria-label="Saved results"'))
      .toBeLessThan(markup.indexOf("<summary>Execution details</summary>"));
    expect(markup).not.toContain("Published successfully");
    expect(markup).not.toContain('href="/work/');
  });

  it("keeps failed results, missing bytes, expiry and omitted final steps explicit", () => {
    const markup = renderAutomationReport({ ...run, outputSummary: { entries: [
      { nodeId: "failed", title: "Failed producer", stepStatus: "failed", availability: "available",
        output: { text: { value: "Partial analysis", truncated: false, totalCharacters: 16 }, full: false },
        errorCode: "automation_agent_acceptance_failed" },
      { nodeId: "expired", title: "Old producer", stepStatus: "succeeded", availability: "expired", output: null },
      { nodeId: "missing", title: "Missing producer", stepStatus: "skipped", availability: "unavailable", output: null },
      { nodeId: "rejected", title: "Rejected producer", stepStatus: "failed", availability: "available", output: null },
    ], omitted: 2 } });
    expect(markup).toContain('data-outcome="failed">Failed');
    expect(markup).toContain("Partial analysis");
    expect(markup).toContain('class="automation-report-warning">Agent result did not meet the step conditions</span>');
    expect(markup).toContain("This saved result has expired.");
    expect(markup.match(/No saved output is available for this step/g)).toHaveLength(2);
    expect(markup).toContain("2 further final-step results are not shown here");
    expect(markup.match(/>Inspect step<\/button>/g)).toHaveLength(4);
  });

  it("leads with a human report and verified target, keeping raw IDs in Diagnostics", () => {
    const markup = renderAutomationRun({
      automations: [], selectedAutomationId: "auto-1", selectedRunId: run.id,
      selectedNodeId: "", runs: [], run, error: "", feedback: "",
    });
    expect(markup.indexOf('aria-label="Saved run report"'))
      .toBeLessThan(markup.indexOf('aria-label="Run timeline"'));
    expect(markup).toContain("Store report");
    expect(markup).toContain("Saved file");
    expect(markup).toContain("1m 0s");
    expect(markup).toContain("write_file");
    expect(markup).toContain("/work/report-2026-09-29.txt");
    expect(markup).toContain("<summary>Diagnostics</summary>");
    expect(markup.indexOf("write_file")).toBeGreaterThan(markup.indexOf("<summary>Diagnostics</summary>"));
    expect(markup.indexOf("private-result-id")).toBeGreaterThan(markup.indexOf("<summary>Diagnostics</summary>"));
  });

  it("shows a recorded target without claiming an unrelated action saved a file", () => {
    const runWithTarget = structuredClone(run);
    runWithTarget.report.effectSummary.entries[0].actions = [
      { type: "establish_target", target: "daily_summary.txt" },
    ];
    const markup = renderAutomationRun({
      automations: [], selectedAutomationId: "auto-1", selectedRunId: run.id,
      selectedNodeId: "", runs: [], run: runWithTarget, error: "", feedback: "",
    });
    expect(markup).toContain("Recorded target</span><strong dir=\"auto\">daily_summary.txt");
    expect(markup).not.toContain("Saved file");
    expect(markup.indexOf("establish_target")).toBeGreaterThan(markup.indexOf("<summary>Diagnostics</summary>"));
  });

  it("keeps unresolved and late evidence visible without presenting unconfirmed outputs as saved", () => {
    const uncertainRun = { ...run, report: { ...run.report, outcome: "failed",
      effectSummary: { ...run.report.effectSummary, unresolvedAttempts: 1,
        entries: [{ ...run.report.effectSummary.entries[0], outcome: "uncertain" }] },
      lateEvidence: [{ nodeId: "write", attemptId: "attempt-1", revision: 2,
        observedAt: "2026-09-29T10:02:00Z", status: "succeeded" }] } };
    const markup = renderAutomationRun({
      automations: [], selectedAutomationId: "auto-1", selectedRunId: run.id,
      selectedNodeId: "", runs: [], run: uncertainRun, error: "", feedback: "",
    });
    expect(markup).toContain("unresolved tool attempt");
    expect(markup).toContain("Later evidence arrived");
    expect(markup).not.toContain("Saved file");
    expect(markup).toContain("No confirmed output target was recorded");
  });

  it("shows reconstructed binding and structured result, with full output behind a click", () => {
    const markup = renderAutomationRun({
      automations: [], selectedAutomationId: "auto-1", selectedRunId: run.id,
      selectedNodeId: "write", runs: [], run, error: "", feedback: "",
      stepEvidence: {
        runId: run.id, nodeId: "write", title: "Store report", availability: "available",
        stepStatus: "succeeded",
        inputs: [{ name: "Payload", source: "Read feed · text", status: "reconstructed",
          preview: { value: '"feed body"', truncated: false, totalCharacters: 11 } }],
        output: { text: { value: "report preview", totalCharacters: 8_000, truncated: true },
          data: { value: '{"path":"/work/report.txt"}', totalCharacters: 27, truncated: false },
          full: false },
        effects: [{ attemptId: "attempt-1", outcome: "succeeded", effect: "mutating",
          actions: [{ type: "write_file", target: "/work/report.txt" }], omittedActions: 0 }],
      },
    });
    expect(markup).toContain("Reconstructed value");
    expect(markup).toContain("Saved structured data");
    expect(markup).toContain('data-action="show-full-step-output"');
    expect(markup).toContain("/work/report.txt");
    expect(markup).toContain("Technical details");
    expect(markup).not.toContain("No output was saved");
    const step = markup.slice(markup.indexOf('aria-label="Step evidence"'));
    expect(step.indexOf("report preview")).toBeLessThan(step.indexOf("<summary>Tool effects"));
    expect(step.indexOf("report preview")).toBeLessThan(step.indexOf("<summary>Configured inputs"));
    expect(step).toContain('<p>feed body</p>');
    expect(step).toContain('data-disclosure-id="step-inputs-write"><summary>Configured inputs');
    expect(step).toContain('data-disclosure-id="step-effects-write"><summary>Tool effects');
  });

  it("keeps an uncertain step's receipt target and later evidence visibly unconfirmed", () => {
    const markup = renderAutomationRun({
      automations: [], selectedAutomationId: "auto-1", selectedRunId: run.id,
      selectedNodeId: "write", runs: [], run, error: "", feedback: "",
      stepEvidence: {
        runId: run.id, nodeId: "write", title: "Store report", availability: "available",
        stepStatus: "failed", inputs: [], output: null,
        effects: [{ attemptId: "attempt-1", outcome: "uncertain", effect: "mutating",
          operation: { toolName: "write_file", operationId: "write_complete_file" },
          actions: [{ type: "write_file", target: "daily_summary.txt" }], omittedActions: 0,
          lateEvidence: { status: "succeeded", observedAt: "2026-09-29T10:02:00Z" } }],
      },
    });
    const step = markup.slice(markup.indexOf('aria-label="Step evidence"'));
    expect(step).toContain("Receipt target · not confirmed");
    expect(step).toContain("original outcome remains Uncertain");
    expect(step).not.toContain("Saved file");
    expect(step.indexOf("write_file")).toBeGreaterThan(step.indexOf("<summary>Technical details</summary>"));
  });

  it("makes full detail an explicit exact-run exact-node request", async () => {
    const requestApi = vi.fn(async () => ({ ok: true }));
    const client = createAutomationRequests({
      requestApi, getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }),
    });
    await client.getAutomationStepEvidence("run 1", "node/2", "dev", true);
    expect(requestApi).toHaveBeenCalledWith(
      "/automation-runs/run%201/steps/node%2F2?environment=dev&full=1",
      undefined,
    );
  });
});
