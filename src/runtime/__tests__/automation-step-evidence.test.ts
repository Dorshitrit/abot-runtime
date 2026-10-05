import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { createAutomationStepEvidenceReader } from "../automations/step-evidence.js";
import { readAutomationRunEffectSummary } from "../automations/step-evidence-effects.js";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationResultStore } from "../automations/result-store.js";
import { emptyAutomationJournalState, type AutomationJournalState } from "../automations/storage-records.js";
import type { SchedulerAutomationRun, SchedulerService } from "../scheduler/contracts.js";

const operation = { toolName: "fixture", operationId: "write", contractVersion: 1 };
const longText = "saved text ".repeat(700);
const definition: AutomationRevision = {
  schemaVersion: 1, automationId: "auto-1", revision: 2,
  title: "Handoff", objective: "Store selected content",
  trigger: { kind: "manual" }, inputs: {},
  body: { kind: "sequence", id: "root", children: [
    { kind: "tool", id: "source", title: "Read feed", onFailure: "stop",
      operation: { ...operation, operationId: "read" }, controls: {} },
    { kind: "tool", id: "store", title: "Store file", onFailure: "stop",
      operation, controls: { payload: { kind: "literal", value: "control payload" } },
      payload: { kind: "node_result", nodeId: "source", select: "text" } },
  ] },
  limits: DEFAULT_AUTOMATION_LIMITS,
};
const run: SchedulerAutomationRun = {
  id: "run-1", jobId: "job-1", environmentId: "dev",
  target: { kind: "automation", automationId: "auto-1", definitionRevision: 2 },
  title: "Handoff", timeZone: "UTC", jobRevision: 1,
  scheduledAt: "2026-09-29T10:00:00Z", trigger: "manual", status: "succeeded",
};

function fixture() {
  const state = emptyAutomationJournalState();
  state.definitions.push({ id: "def-1", automationId: "auto-1", revision: 2,
    definition, publishedAt: "2026-09-29T10:00:00Z" });
  state.executions.push({
    id: run.id, automationId: "auto-1", definitionRevision: 2, revision: 1, inputIds: [],
    nodes: [
      { nodeId: "source", status: "succeeded", resultRef: "source-result" },
      { nodeId: "store", status: "succeeded", resultRef: "store-result" },
    ],
  });
  state.attempts.push({
    id: "attempt-store", runId: run.id, nodeId: "store",
    invocationId: "invocation-store", fingerprint: "fingerprint",
    state: "settled", startedAt: "2026-09-29T10:00:00Z",
    settlementRef: "store-result",
  });
  state.results.push(
    { id: "source-result", runId: run.id, nodeId: "source", kind: "node_output",
      storageRef: "source", digest: "sha", sizeBytes: 1, createdAt: "2026-09-29T10:00:00Z" },
    { id: "store-result", runId: run.id, nodeId: "store", kind: "node_output",
      storageRef: "store", digest: "sha", sizeBytes: 1, createdAt: "2026-09-29T10:00:00Z" },
  );
  const saved = new Map<string, unknown>([
    ["source-result", { text: "five RSS items", data: { count: 5 },
      receipt: { ok: true, effect: "read_only", completionActions: [] } }],
    ["store-result", { text: longText, data: { path: "/tmp/news.txt" },
      receipt: { ok: true, effect: "mutating",
        completionActions: [{ type: "write_file", target: "/tmp/news.txt" }] } }],
  ]);
  const results = { read: async (record: { id: string }) => saved.get(record.id) } as unknown as AutomationResultStore;
  const persistence = { read: async () => structuredClone(state) } as AutomationPersistence;
  const scheduler = { getAutomationRun: async () => run } as unknown as Pick<SchedulerService, "getAutomationRun">;
  return { state, saved, results, reader: createAutomationStepEvidenceReader({
    scheduler, persistence, results,
  }) };
}

describe("ABot Studio saved step evidence", () => {
  it("projects exact committed input, output and receipt; full output requires explicit read", async () => {
    const { reader, state, results } = fixture();
    const preview = await reader.get(run.id, "store");
    expect(preview.title).toBe("Store file");
    expect(preview.inputs).toMatchObject([
      { name: "Control · payload", status: "reconstructed" },
      { name: "Payload", source: "Read feed · text", status: "reconstructed" },
    ]);
    expect(preview.inputs[1]?.preview?.value).toBe("five RSS items");
    expect(preview.output?.text?.truncated).toBe(true);
    expect(JSON.parse(preview.output!.data!.value)).toEqual({ path: "/tmp/news.txt" });
    expect(preview.effects).toMatchObject([{ outcome: "succeeded", effect: "mutating",
      actions: [{ type: "write_file", target: "/tmp/news.txt" }] }]);
    expect((await reader.get(run.id, "store", true)).output?.text?.value).toBe(longText);
    const summary = await readAutomationRunEffectSummary({
      state, results, runId: run.id, definition,
    });
    expect(summary).toMatchObject({ total: 1, verifiedExecutions: 1, unresolvedAttempts: 0 });
  });

  it("does not accept a result record from another run", async () => {
    const { reader, state } = fixture();
    state.results[1] = { ...state.results[1]!, runId: "other-run" };
    await expect(reader.get(run.id, "store")).rejects.toThrow("automation_result_ref_invalid");
  });

  it.each(["rejected", "uncertain"] as const)(
    "renders %s direct-tool settlement without treating it as saved text", async (kind) => {
      const { reader, state, saved } = fixture();
      saved.set("store-result", { kind, code: `fixture_${kind}`, message: "Internal error text" });
      state.attempts[0] = { ...state.attempts[0]!, state: kind === "uncertain" ? "uncertain" : "settled",
        ...(kind === "uncertain" ? { lateSettlement: {
          revision: 2, observedAt: "2026-09-29T10:01:00Z", status: "succeeded" as const,
        } } : {}) };
      const evidence = await reader.get(run.id, "store");
      expect(evidence.output).toBeNull();
      expect(evidence.effects[0]).toMatchObject({
        outcome: kind, errorCode: `fixture_${kind}`, actions: [],
      });
      if (kind === "uncertain")
        expect(evidence.effects[0]?.lateEvidence?.status).toBe("succeeded");
    },
  );

  it("shows a pre-dispatch rejection without inventing a tool attempt", async () => {
    const { reader, state, saved } = fixture();
    state.attempts = [];
    saved.set("store-result", { kind: "rejected", code: "automation_operation_unavailable",
      message: "Private internal diagnostic" });
    const evidence = await reader.get(run.id, "store");
    expect(evidence.output).toBeNull();
    expect(evidence.savedOutcome).toEqual({
      kind: "rejected", errorCode: "automation_operation_unavailable",
    });
    expect(evidence.effects).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("Private internal diagnostic");
  });

  it("distinguishes no saved output from expired detail", async () => {
    const { reader, state } = fixture();
    state.executions[0] = { ...state.executions[0]!,
      nodes: [state.executions[0]!.nodes[0]!, { nodeId: "store", status: "pending" }] };
    expect((await reader.get(run.id, "store")).output).toBeNull();
    state.executions[0] = { ...state.executions[0]!, detailsExpiredAt: "2026-10-29T10:00:00Z" };
    const expired = await reader.get(run.id, "store");
    expect(expired.availability).toBe("expired");
    expect(expired.inputs).toEqual([]);
    expect(expired.effects).toEqual([]);
  });
});
