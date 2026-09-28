import { describe, expect, test } from "vitest";
import {
  parseStoredJob,
  parseStoredRun,
} from "../scheduler/snapshot-validation.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";
import type { SchedulerJob } from "../scheduler/contracts.js";

const job: SchedulerJob = {
  id: "job",
  environmentId: "test",
  sessionId: "session",
  title: "Task",
  prompt: "Task",
  modelProfileId: "model",
  agentMode: "fast",
  toolPermissionMode: "full_plus",
  timeZone: "UTC",
  schedule: { kind: "daily", at: "09:00" },
  state: "active",
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
  nextRunAt: "2026-09-25T09:00:00Z",
  revision: 2,
};

describe("scheduler persisted permission", () => {
  test("reads legacy runs without deriving permission from the current FULL+ job", () => {
    const run = makeSchedulerRun(job, "2026-09-24T09:00:00Z", "schedule");
    delete run.toolPermissionMode;
    const restored = parseStoredRun(run);
    expect(restored.toolPermissionMode).toBeUndefined();
    expect(restored.toolPermissionMode ?? "full_access").toBe("full_access");
    expect(parseStoredJob(job).toolPermissionMode).toBe("full_plus");
  });
  test.each(["ask", "FULL+", null])(
    "rejects unsupported stored run authority %s",
    (mode) => {
      const run = makeSchedulerRun(job, "2026-09-24T09:00:00Z", "schedule");
      expect(() =>
        parseStoredRun({ ...run, toolPermissionMode: mode }),
      ).toThrow();
      expect(() =>
        parseStoredJob({ ...job, toolPermissionMode: mode }),
      ).toThrow();
    },
  );
});
