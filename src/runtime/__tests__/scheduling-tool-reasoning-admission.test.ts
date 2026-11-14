import { afterEach, expect, test, vi } from "vitest";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import type { ToolApprovalController } from "../ports.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const controls = {
  title: "Reminder", prompt: "Remind me to act", timeZone: "UTC", delayMs: 3_600_000,
};
const sharedState = {
  currentSessionId: "session",
  requestContext: {
    agentMode: "fast" as const, toolPermissionMode: "full_access" as const,
    modelPreference: { profileId: "scheduled-model", scope: "all" as const },
  },
};

async function fixture() {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  f.config.models!.providers!.local.type = "openai";
  f.config.models!.profiles!["scheduled-model"].supportsThinking = true;
  const module = createSchedulingToolModule(f.scheduler, f.config, async () => undefined);
  const create = (extra: Record<string, unknown> = {}) => module.implementation({
    action: "create", scheduleKind: "timer", ...controls, ...extra,
  }, { sharedState });
  const edit = async (jobId: string, extra: Record<string, unknown>) => {
    const params = { action: "update", jobId, ...extra };
    const binding = await module.adapter!.executionBinding!({ tool: "schedules", params }, {
      sessionId: "session", toolPermissionMode: "full_access",
    });
    return module.implementation(params, {
      sharedState,
      executionAuthority: { toolPermissionMode: "full_access", executionIdentity: binding.identity },
    });
  };
  return { ...f, module, create, edit };
}

test("tool rejects incompatible explicit controls at create/update and accepts inheritance", async () => {
  const f = await fixture();
  for (const reasoningMode of ["off", "server-default", "budget"]) {
    const result = await f.create({ reasoningMode,
      ...(reasoningMode === "budget" ? { reasoningBudgetTokens: 128 } : {}) });
    expect(result).toMatchObject({ ok: false, producedNewInformation: false });
    expect(result.error).toContain("reasoning_budget_unsupported");
    expect(await f.scheduler.list()).toEqual([]);
  }
  expect(await f.create()).toMatchObject({ ok: true });
  expect(await f.create({ reasoningMode: "inherit" })).toMatchObject({ ok: true });
  const job = (await f.scheduler.list())[0]!;
  expect(job.reasoningPreference).toBeUndefined();
  const invalid = await f.edit(job.id, { title: "Must not persist", reasoningMode: "off" });
  expect(invalid.ok).toBe(false);
  expect(invalid.error).toContain("reasoning_budget_unsupported");
  expect(await f.scheduler.get(job.id)).toEqual(job);
  expect(await f.scheduler.listRuns()).toEqual([]);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("tool inheritance explicitly clears an incompatible preference already saved", async () => {
  const f = await fixture();
  f.config.models!.providers!.local.type = "llamacpp";
  expect(await f.create({ reasoningMode: "server-default" })).toMatchObject({ ok: true });
  const job = (await f.scheduler.list())[0]!;
  f.config.models!.providers!.local.type = "openai";
  expect(await f.edit(job.id, { title: "Still incompatible" })).toMatchObject({ ok: false });
  expect(await f.scheduler.get(job.id)).toEqual(job);
  expect(await f.edit(job.id, { reasoningMode: "inherit" })).toMatchObject({ ok: true });
  const cleared = await f.scheduler.get(job.id);
  expect(cleared?.reasoningPreference).toBeUndefined();
  expect(cleared?.revision).toBe(job.revision + 1);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("tool model switches preserve the existing implicit inheritance behavior", async () => {
  const f = await fixture();
  f.config.models!.providers!.local.type = "llamacpp";
  f.config.models!.providers!.cloud = { type: "openai" };
  f.config.models!.profiles!.cloud = {
    provider: "cloud", model: "cloud", contextWindowTokens: 8000, supportsThinking: true,
  };
  expect(await f.create({ reasoningMode: "budget", reasoningBudgetTokens: 128 })).toMatchObject({ ok: true });
  const job = (await f.scheduler.list())[0]!;
  expect(await f.edit(job.id, { modelProfileId: "cloud", reasoningMode: "off" })).toMatchObject({ ok: false });
  expect(await f.scheduler.get(job.id)).toEqual(job);
  expect(await f.edit(job.id, { modelProfileId: "cloud" })).toMatchObject({ ok: true });
  const switched = await f.scheduler.get(job.id);
  expect(switched?.modelProfileId).toBe("cloud");
  expect(switched?.reasoningPreference).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each([false, true])("restored approval checks current reasoning support before saving (changed=%s)", async (changed) => {
  const f = await fixture();
  f.config.models!.providers!.local.type = "llamacpp";
  const registry = createConfiguredToolRegistry(f.config, [f.module]);
  const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(async () => ({ approved: true }));
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(), toolRegistry: registry,
    requestId: "reasoning-approval", abortSignal: new AbortController().signal,
    toolPermissionMode: "ask", sharedState,
    nextApprovalId: () => "reasoning-approval-id", toolApprovalController: { requestToolApproval },
  });
  const operation = executor.operations.find((entry) => entry.operation.operationId === "create_timer")!;
  const prepared = await executor.prepare({ handle: operation.handle,
    controls: { ...controls, reasoningMode: "server-default" } });
  if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
  const snapshot = JSON.parse(JSON.stringify(prepared.snapshot));
  if (changed) f.config.models!.providers!.local.type = "openai";
  const restored = await executor.restore(snapshot);
  if (restored.status !== "prepared") throw new Error(JSON.stringify(restored));
  expect(restored.approvalRequest).toEqual(prepared.approvalRequest);
  expect(await restored.execute()).toMatchObject({ status: "executed", result: { ok: !changed } });
  expect(requestToolApproval).toHaveBeenCalledOnce();
  expect(await f.scheduler.list()).toHaveLength(changed ? 0 : 1);
  expect(f.invoke).not.toHaveBeenCalled();
});
