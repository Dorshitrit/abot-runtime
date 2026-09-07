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
  CreateSchedulerJobInput,
  SchedulerService,
} from "../scheduler/contracts.js";
import { validateSchedulerJobInput } from "../scheduler/schedule-validation.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const variants = [
  { kind: "timer", timing: { delayMs: 60_000 }, required: ["delayMs"] },
  {
    kind: "once",
    timing: { at: "2026-09-07T09:00:00+03:00" },
    required: ["at"],
  },
  { kind: "interval", timing: { everyMs: 60_000 }, required: ["everyMs"] },
  {
    kind: "daily",
    timing: { at: "09:00", timeZone: "Asia/Jerusalem" },
    required: ["at", "timeZone"],
  },
  {
    kind: "weekly",
    timing: { at: "09:00", weekdays: [3, 6], timeZone: "Asia/Jerusalem" },
    required: ["at", "weekdays", "timeZone"],
  },
  {
    kind: "monthly",
    timing: { at: "09:00", dayOfMonth: 15, timeZone: "Asia/Jerusalem" },
    required: ["at", "dayOfMonth", "timeZone"],
  },
] as const;
const details = { title: "News", prompt: "Summarize the news" };

function createOperation(kind: string): ToolNormalInvocationOperation {
  const operation = schedulingToolContract.operations.find(
    (entry) => entry.operationId === `create_${kind}`,
  );
  if (!operation) throw new Error(`missing create operation: ${kind}`);
  return operation;
}

describe.each(variants)(
  "$kind creation contract",
  ({ kind, timing, required }) => {
    it("requires every timing field before the operation can be accepted", () => {
      // Also reproduces the old broad create schema, rather than only a renamed ID.
      const operation = schedulingToolContract.operations.find(
        (entry) =>
          entry.operationId === `create_${kind}` ||
          entry.operationId === "create",
      )!;
      const valid: Record<string, unknown> = { ...details, ...timing };
      if (operation.operationId === "create") valid.scheduleKind = kind;
      expect(validateToolNormalInvocationInput(operation, valid).ok).toBe(true);
      for (const field of ["title", "prompt", ...required]) {
        const incomplete = { ...valid };
        delete incomplete[field];
        expect(
          validateToolNormalInvocationInput(operation, incomplete).ok,
          field,
        ).toBe(false);
      }
    });

    it("binds the exact schedule kind through the registered call path", async () => {
      const create = vi.fn(async (input: CreateSchedulerJobInput) => {
        validateSchedulerJobInput(input);
        return input;
      });
      const service = { create } as unknown as SchedulerService;
      const module = createSchedulingToolModule(
        service,
        loadPublicRuntimeConfig([]),
        async () => undefined,
      );
      const registrations = createToolRegistry({
        modules: [module],
      }).getNormalInvocations();
      const operation = createOperation(kind);
      const controls = { ...details, ...timing };
      const call = materializeCall(
        { registration: registrations[0]!, operation },
        controls,
        undefined,
      );
      const target = resolveExactTargetOperation(registrations, call);
      expect(target.ok).toBe(true);
      if (!target.ok) throw new Error("creation binding rejected");
      expect(target.binding.operation.operationId).toBe(`create_${kind}`);
      expect(call.params).toMatchObject({
        action: "create",
        scheduleKind: kind,
      });
      const result = await module.implementation(call.params, {
        sharedState: {
          currentSessionId: "current-session",
          requestContext: {
            agentMode: "fast",
            toolPermissionMode: "ask",
            modelPreference: { profileId: "default", scope: "all" },
          },
        },
      });
      expect(result.ok, result.output).toBe(true);
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0][0]).toMatchObject({
        sessionId: "current-session",
        modelProfileId: "default",
        agentMode: "fast",
        ...details,
        schedule: { kind },
      });
    });

    it("rejects caller overrides of fixed kind, action, model, or session", () => {
      const operation = createOperation(kind);
      for (const extra of [
        { scheduleKind: "timer" },
        { action: "cancel" },
        { modelProfileId: "foreign" },
        { sessionId: "foreign" },
      ]) {
        expect(
          validateToolNormalInvocationInput(operation, {
            ...details,
            ...timing,
            ...extra,
          }).ok,
        ).toBe(false);
      }
    });
  },
);

it("advertises only the six closed create variants and preserves management operations", () => {
  const operations = schedulingToolContract.operations;
  expect(
    operations
      .filter((entry) => entry.fixedParams?.action === "create")
      .map((entry) => entry.operationId),
  ).toEqual(variants.map(({ kind }) => `create_${kind}`));
  expect(
    operations
      .filter((entry) => entry.fixedParams?.action !== "create")
      .filter((entry) => !entry.operationId.startsWith("update_"))
      .map((entry) => entry.operationId),
  ).toEqual(["list", "get", "update", "pause", "resume", "cancel", "run_now"]);
  for (const operation of operations) {
    expect(operation.approval).toBe("request_policy");
    expect(operation.input.additionalProperties).toBe(false);
    expect(operation.input.properties).not.toHaveProperty("toolPermissionMode");
  }
});
