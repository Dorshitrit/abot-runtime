import { describe, expect, test } from "vitest";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import {
  observeAutomationRunChanges,
  type AutomationRunChange,
} from "../scheduler/automation-run-change-events.js";
import type {
  SchedulerAutomationRun,
  SchedulerSnapshot,
  SchedulerStore,
} from "../scheduler/contracts.js";

function automationRun(id: string, status: SchedulerAutomationRun["status"] = "pending"):
  SchedulerAutomationRun {
  return {
    id, jobId: "job", environmentId: "dev",
    target: { kind: "automation", automationId: "flow", definitionRevision: 1 },
    title: "Daily report", timeZone: "UTC", jobRevision: 1,
    scheduledAt: "2026-09-29T10:00:00.000Z", trigger: "manual", status,
  };
}

function fixture() {
  let committed: SchedulerSnapshot = {
    schemaVersion: 1, jobs: [], runs: [automationRun("first")],
  };
  let rejectNextCommit = false;
  const events: { change: AutomationRunChange; committedStatus: string }[] = [];
  const store: SchedulerStore = {
    acquire: async () => async () => undefined,
    read: async () => structuredClone(committed),
    async update(mutate) {
      const next = structuredClone(committed);
      const result = mutate(next);
      if (rejectNextCommit) {
        rejectNextCommit = false;
        throw new Error("commit_failed");
      }
      committed = next;
      return result;
    },
    async updateWithAutomations(mutate) {
      const next = structuredClone(committed);
      const result = mutate(next, emptyAutomationJournalState());
      if (rejectNextCommit) {
        rejectNextCommit = false;
        throw new Error("commit_failed");
      }
      committed = next;
      return result;
    },
  };
  const observed = observeAutomationRunChanges(store, (change) => {
    const run = committed.runs.find((item) => item.id === change.runId);
    events.push({ change, committedStatus: run?.status || "missing" });
  });
  return {
    observed, events,
    rejectCommit: () => { rejectNextCommit = true; },
  };
}

describe("committed automation run changes", () => {
  test("announces actual start and every terminal outcome after durable updates", async () => {
    const { observed, events } = fixture();
    await observed.update((state) => {
      const run = state.runs[0] as SchedulerAutomationRun;
      run.status = "running";
      run.startedAt = "2026-09-29T10:01:00.000Z";
    });
    await observed.update((state) => {
      (state.runs[0] as SchedulerAutomationRun).status = "stopping";
    });
    await observed.updateWithAutomations!((state) => {
      const run = state.runs[0] as SchedulerAutomationRun;
      run.status = "completed_with_skips";
      run.finishedAt = "2026-09-29T10:02:00.000Z";
      state.runs.push(automationRun("failed", "failed"));
      state.runs.push(automationRun("cancelled", "cancelled"));
      state.runs.push(automationRun("missed", "missed"));
      state.runs.push(automationRun("interrupted", "interrupted"));
    });
    await observed.update(() => undefined);
    expect(events.map(({ change }) => [change.runId, change.phase, change.status])).toEqual([
      ["first", "started", "running"],
      ["first", "finished", "completed_with_skips"],
      ["failed", "finished", "failed"],
      ["cancelled", "finished", "cancelled"],
      ["missed", "finished", "missed"],
      ["interrupted", "finished", "interrupted"],
    ]);
    expect(events.every(({ change, committedStatus }) => change.status === committedStatus))
      .toBe(true);
    expect(events[0].change).toMatchObject({
      environmentId: "dev", automationId: "flow", title: "Daily report",
    });
  });

  test("a failed terminal commit does not emit a finish or change durable state", async () => {
    const { observed, events, rejectCommit } = fixture();
    rejectCommit();
    await expect(observed.updateWithAutomations!((state) => {
      (state.runs[0] as SchedulerAutomationRun).status = "failed";
    })).rejects.toThrow("commit_failed");
    expect(events).toEqual([]);
    expect((await observed.read()).runs[0].status).toBe("pending");
  });
});
