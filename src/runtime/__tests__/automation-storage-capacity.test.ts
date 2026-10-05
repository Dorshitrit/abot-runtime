import { describe, expect, it } from "vitest";
import {
  commitInputObservation,
  MAX_INPUT_SNAPSHOT_BYTES,
  sourceBaselineMarker,
} from "../automations/input-ledger.js";
import {
  MAX_AUTOMATION_RESULT_BYTES,
  requireAutomationResultCapacity,
} from "../automations/result-capacity.js";
import { emptyAutomationJournalState, type AutomationInputRecord } from "../automations/storage-records.js";

function snapshotRecord(id: string): AutomationInputRecord {
  return {
    id, automationId: "automation", sourceId: "source",
    canonicalPath: `/source/${id}.txt`, contentVersion: id,
    observedAt: "2026-09-29T00:00:00.000Z", eligibility: "eligible",
    snapshot: {
      attachment: { id, kind: "file", mimeType: "text/plain", storageRef: `owner/${id}.txt` },
      contentVersion: id, sizeBytes: 1,
    },
  };
}

describe("automation retained storage bounds", () => {
  it("admits a full 1000-file baseline together with its source marker", () => {
    const state = emptyAutomationJournalState();
    const baselineFiles = Array.from({ length: 1_000 }, (_, index): AutomationInputRecord => ({
      id: `baseline-${index}`, automationId: "automation", sourceId: "source",
      canonicalPath: `/source/${index}.txt`, contentVersion: `${index}`,
      observedAt: "2026-09-29T00:00:00.000Z", eligibility: "baseline",
    }));
    expect(() => commitInputObservation({ state, baselineFiles,
      marker: sourceBaselineMarker({ automationId: "automation", sourceId: "source",
        root: "/source", observedAt: "2026-09-29T00:00:00.000Z" }),
    })).not.toThrow();
    expect(state.inputs).toHaveLength(1_001);
    expect(state.inputs.filter((record) => record.baselineMarker)).toHaveLength(1);
  });

  it("does not charge retained dedup history from other automations against new snapshots", () => {
    const state = emptyAutomationJournalState();
    state.inputs = Array.from({ length: 1_001 }, (_, index) => {
      const { snapshot: _snapshot, ...record } = snapshotRecord(`consumed-${index}`);
      return { ...record, automationId: `historical-${index % 2}`,
        claimRunId: `run-${index}`, outcomeRef: `report-${index}` };
    });
    const history = structuredClone(state.inputs);
    expect(() => commitInputObservation({ state, newFiles: [snapshotRecord("next")] }))
      .not.toThrow();
    expect(state.inputs.slice(0, 1_001)).toEqual(history);
    expect(state.inputs.at(-1)?.snapshot).toBeDefined();
  });

  it("counts active, held and replayable snapshots until their bytes are retired", () => {
    const state = emptyAutomationJournalState();
    state.inputs = Array.from({ length: 1_000 }, (_, index) => ({
      ...snapshotRecord(`retained-${index}`), claimRunId: `run-${index}`,
      ...(index % 2 ? { outcomeRef: `report-${index}` } : { eligibility: "held" as const }),
    }));
    expect(() => commitInputObservation({
      state: structuredClone(state), newFiles: [snapshotRecord("blocked")],
    })).toThrow("automation_source_capacity_exceeded");
    const { snapshot: _snapshot, ...retired } = state.inputs[1]!;
    state.inputs[1] = retired;
    expect(() => commitInputObservation({ state, newFiles: [snapshotRecord("allowed")] }))
      .not.toThrow();
    expect(state.inputs.filter((record) => record.snapshot)).toHaveLength(1_000);
    expect(state.inputs[1]).toEqual(retired);
  });

  it("bounds historical metadata per automation without blocking unrelated intake", () => {
    const state = emptyAutomationJournalState();
    state.inputs = Array.from({ length: 8_000 }, (_, index) => {
      const { snapshot: _snapshot, ...record } = snapshotRecord(`old-${index}`);
      return { ...record, canonicalPath: `/${"x".repeat(4_095)}`,
        sourceId: `old-source-${index % 2}`, claimRunId: `run-${index}`, outcomeRef: `report-${index}` };
    });
    expect(Buffer.byteLength(JSON.stringify(state.inputs))).toBeGreaterThan(32 * 1024 * 1024);
    expect(() => commitInputObservation({ state, newFiles: [{
      ...snapshotRecord("other"), automationId: "unrelated",
    }] })).not.toThrow();
    expect(() => commitInputObservation({ state, newFiles: [{
      ...snapshotRecord("same-owner-new-source"), sourceId: "changed-source",
    }] })).toThrow("automation_source_capacity_exceeded");
    expect(state.inputs.slice(0, 8_000).every((record) => record.outcomeRef)).toBe(true);
  });

  it("refuses another source snapshot when retained source bytes reach capacity", () => {
    const state = emptyAutomationJournalState();
    const record = (id: string, sizeBytes: number) => ({
      id, automationId: "automation", sourceId: "source",
      canonicalPath: `/source/${id}.pdf`, contentVersion: id,
      observedAt: "2026-09-29T00:00:00.000Z" as const,
      eligibility: "eligible" as const,
      snapshot: {
        attachment: { id, kind: "file" as const, mimeType: "application/pdf",
          storageRef: `owner/${id}.pdf` },
        contentVersion: id, sizeBytes,
      },
    });
    state.inputs.push(record("first", MAX_INPUT_SNAPSHOT_BYTES));
    expect(() => commitInputObservation({
      state, newFiles: [record("second", 1)],
    })).toThrow("automation_source_capacity_exceeded");
  });

  it("bounds total retained result bytes across separate runs", () => {
    const state = emptyAutomationJournalState();
    state.results.push({
      id: "result-1", runId: "run-1", kind: "report",
      storageRef: "automation-results/result-1.json", digest: "digest",
      sizeBytes: MAX_AUTOMATION_RESULT_BYTES,
      createdAt: "2026-09-29T00:00:00.000Z",
    });
    expect(() => requireAutomationResultCapacity(state, 1))
      .toThrow("automation_artifact_budget_exhausted");
  });
});
