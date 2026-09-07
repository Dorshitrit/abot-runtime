import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../../capabilities/registry.js";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/index.js";
import type { ToolNormalInvocationOperation } from "../../capabilities/tool-types.js";
import {
  materializeCall,
  resolveExactTargetOperation,
} from "../adapters/registered-tool-normal-invocations/execution/call-binding.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import { schedulingToolContract } from "../capabilities/scheduling/tool-contract.js";
import type {
  SchedulerJob,
  SchedulerService,
  UpdateSchedulerJobInput,
} from "../scheduler/contracts.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const variants = [
  { kind: "timer", timing: { delayMs: 60_000 }, required: ["delayMs"] },
  {
    kind: "once",
    timing: { at: "2099-09-07T09:00:00+03:00" },
    required: ["at"],
  },
  { kind: "interval", timing: { everyMs: 60_000 }, required: ["everyMs"] },
  { kind: "daily", timing: { at: "09:00" }, required: ["at"] },
  {
    kind: "weekly",
    timing: { at: "09:00", weekdays: [3, 6] },
    required: ["at", "weekdays"],
  },
  {
    kind: "monthly",
    timing: { at: "09:00", dayOfMonth: 15 },
    required: ["at", "dayOfMonth"],
  },
] as const;

function operationById(id: string): ToolNormalInvocationOperation {
  const operation = schedulingToolContract.operations.find(
    (entry) => entry.operationId === id,
  );
  if (!operation) throw new Error(`missing operation: ${id}`);
  return operation;
}

function fixture() {
  const job: SchedulerJob = {
    id: "job",
    sessionId: "current-session",
    environmentId: "test",
    title: "Saved title",
    prompt: "Saved prompt",
    modelProfileId: "default",
    agentMode: "deep",
    toolPermissionMode: "full_access",
    timeZone: "Asia/Jerusalem",
    state: "active",
    schedule: { kind: "daily", at: "10:00" },
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2099-09-07T07:00:00.000Z",
  };
  const update = vi.fn(async (_id: string, patch: UpdateSchedulerJobInput) => ({
    ...job,
    ...patch,
  }));
  const get = vi.fn(async () => job);
  const module = createSchedulingToolModule(
    { get, update } as unknown as SchedulerService,
    loadPublicRuntimeConfig([]),
    async () => {},
  );
  const registrations = createToolRegistry({
    modules: [module],
  }).getNormalInvocations();
  const context = { sharedState: { currentSessionId: "current-session" } };
  return { job, update, get, module, registrations, context };
}

describe.each(variants)(
  "$kind update contract",
  ({ kind, timing, required }) => {
    it("rejects missing timing before a call can bind to the canonical operation", () => {
      const f = fixture();
      // Match the old broad schema too, so red evidence proves missing controls.
      const operation =
        schedulingToolContract.operations.find(
          (entry) => entry.operationId === `update_${kind}`,
        ) ?? operationById("update");
      const controls: Record<string, unknown> = { jobId: "job", ...timing };
      if (operation.operationId === "update") controls.scheduleKind = kind;
      expect(validateToolNormalInvocationInput(operation, controls).ok).toBe(
        true,
      );
      for (const field of ["jobId", ...required]) {
        const incomplete = { ...controls };
        delete incomplete[field];
        expect(
          validateToolNormalInvocationInput(operation, incomplete).ok,
          field,
        ).toBe(false);
        const call = materializeCall(
          { registration: f.registrations[0], operation },
          incomplete,
          undefined,
        );
        expect(
          resolveExactTargetOperation(f.registrations, call).ok,
          field,
        ).toBe(false);
      }
      expect(f.update).not.toHaveBeenCalled();
    });

    it("binds exact kind and owned Job while retaining saved zone and model", async () => {
      const f = fixture();
      const operation = operationById(`update_${kind}`);
      const call = materializeCall(
        { registration: f.registrations[0], operation },
        { jobId: f.job.id, ...timing },
        undefined,
      );
      const target = resolveExactTargetOperation(f.registrations, call);
      expect(target.ok).toBe(true);
      if (!target.ok) throw new Error("update binding rejected");
      expect(target.binding.operation.operationId).toBe(`update_${kind}`);
      expect(call.params).toMatchObject({
        action: "update",
        scheduleKind: kind,
      });
      const result = await f.module.implementation(call.params, f.context);
      expect(result.ok, result.output).toBe(true);
      expect(f.get).toHaveBeenCalledExactlyOnceWith(f.job.id);
      expect(f.update).toHaveBeenCalledExactlyOnceWith(f.job.id, {
        schedule: { kind, ...timing },
      });
    });

    it("rejects fixed bindings, unrelated timing, and foreign identity controls", () => {
      const operation = operationById(`update_${kind}`);
      const irrelevant =
        kind === "timer" ? { everyMs: 60_000 } : { delayMs: 60_000 };
      for (const extra of [
        { scheduleKind: "weekly" },
        { action: "cancel" },
        { sessionId: "foreign" },
        { toolPermissionMode: "ask" },
        irrelevant,
      ])
        expect(
          validateToolNormalInvocationInput(operation, {
            jobId: "job",
            ...timing,
            ...extra,
          }).ok,
        ).toBe(false);
    });
  },
);

it("registers all 19 operations and preserves unrelated management bindings", () => {
  const f = fixture();
  const operations = f.registrations[0].contract.operations;
  expect(operations).toHaveLength(19);
  expect(new Set(operations.map((entry) => entry.operationId)).size).toBe(19);
  expect(
    operations
      .filter((entry) => entry.fixedParams?.action === "update")
      .map((entry) => entry.operationId),
  ).toEqual(["update", ...variants.map(({ kind }) => `update_${kind}`)]);
  for (const id of ["list", "get", "pause", "resume", "cancel", "run_now"]) {
    const operation = operationById(id);
    const call = materializeCall(
      { registration: f.registrations[0], operation },
      id === "list" ? {} : { jobId: "job" },
      undefined,
    );
    const target = resolveExactTargetOperation(f.registrations, call);
    expect(target.ok).toBe(true);
    if (!target.ok) throw new Error("management binding rejected");
    expect(target.binding.operation.operationId).toBe(id);
  }
});

it.each([
  { title: "Changed" },
  { timeZone: "UTC" },
  { prompt: "New task", modelProfileId: "default", agentMode: "fast" },
])("keeps metadata updates free of recurrence changes: %j", async (patch) => {
  const f = fixture();
  const operation = operationById("update");
  const controls = { jobId: f.job.id, ...patch };
  expect(validateToolNormalInvocationInput(operation, controls).ok).toBe(true);
  const call = materializeCall(
    { registration: f.registrations[0], operation },
    controls,
    undefined,
  );
  expect(resolveExactTargetOperation(f.registrations, call).ok).toBe(true);
  expect((await f.module.implementation(call.params, f.context)).ok).toBe(true);
  expect(f.update).toHaveBeenCalledExactlyOnceWith(f.job.id, patch);
  for (const timing of [
    { scheduleKind: "weekly", at: "09:00", weekdays: [6] },
    { at: "09:00" },
    { anchorAt: "2099-09-07T06:00:00Z" },
  ])
    expect(
      validateToolNormalInvocationInput(operation, { ...controls, ...timing })
        .ok,
    ).toBe(false);
});

it("still rejects a correctly bound update of another conversation's Job", async () => {
  const f = fixture();
  f.job.sessionId = "foreign";
  const operation = operationById("update_weekly");
  const call = materializeCall(
    { registration: f.registrations[0], operation },
    { jobId: f.job.id, at: "09:00", weekdays: [6] },
    undefined,
  );
  expect(await f.module.implementation(call.params, f.context)).toMatchObject({
    ok: false,
    error: "schedule_job_not_found",
  });
  expect(f.update).not.toHaveBeenCalled();
});

it("allows an explicit interval anchor and zone without introducing unrelated timing", async () => {
  const f = fixture();
  const operation = operationById("update_interval");
  const controls = {
    jobId: f.job.id,
    everyMs: 1001,
    anchorAt: "2099-09-07T06:00:00.123Z",
    timeZone: "UTC",
    title: "Retimed",
  };
  expect(validateToolNormalInvocationInput(operation, controls).ok).toBe(true);
  const call = materializeCall(
    { registration: f.registrations[0], operation },
    controls,
    undefined,
  );
  expect((await f.module.implementation(call.params, f.context)).ok).toBe(true);
  expect(f.update).toHaveBeenCalledExactlyOnceWith(f.job.id, {
    title: "Retimed",
    timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 1001, anchorAt: controls.anchorAt },
  });
});
