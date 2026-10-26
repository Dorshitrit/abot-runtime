import { afterEach, expect, test, vi } from "vitest";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerSnapshot, SchedulerStore } from "../scheduler/contracts.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const config: RuntimeConfig = {
  runtimeId: "test", agentBridgeUrl: "ws://test", modelGatewayUrl: "http://test",
  requestRunner: { configPath: "/unused/runner.json" },
  paths: {
    rootDir: "/unused", runtimeDir: "/unused/runtime", agentWorkDir: "/unused/work",
    sessionsDir: "/unused/sessions", attachmentsDir: "/unused/attachments",
    workspaceDir: "/unused/workspace", sharedDir: "/unused/shared",
    compiledDir: "/unused/compiled", traceFile: "/unused/trace.jsonl",
  },
  models: {
    defaults: { profileId: "local" },
    providers: { llama: { type: "llamacpp" } },
    profiles: Object.fromEntries(["local", "other", "budget", "off", "server-default", "inherit"].map((id) => [
      id, { provider: "llama", model: id, supportsThinking: true, contextWindowTokens: 8000 },
    ])),
  },
};

test("schedule tool model updates clear only stale omitted reasoning controls", async () => {
  let snapshot: SchedulerSnapshot = { schemaVersion: 1, jobs: [], runs: [] };
  const store: SchedulerStore = {
    acquire: async () => async () => undefined,
    read: async () => structuredClone(snapshot),
    update: async (mutate) => {
      const next = structuredClone(snapshot);
      const result = mutate(next);
      snapshot = next;
      return result;
    },
  };
  const start = vi.fn(async () => ({ status: "succeeded" as const }));
  const service = createSchedulerService({
    environmentId: "test", store, tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null, start },
  });
  cleanups.push(() => service.stop());
  await service.start();
  const original = { profileId: "local", mode: "budget", budgetTokens: 128 } as const;
  const job = await service.create({
    sessionId: "session", title: "Think", prompt: "Answer",
    modelProfileId: "local", agentMode: "fast", reasoningPreference: original,
    timeZone: "UTC", schedule: { kind: "timer", delayMs: 3_600_000 },
  });
  await service.runNow(job.id);
  const module = createSchedulingToolModule(service, config, async () => undefined);
  const edit = async (params: Record<string, unknown>) => {
    const input = { action: "update", jobId: job.id, ...params };
    const binding = await module.adapter!.executionBinding!({ tool: "schedules", params: input },
      { toolPermissionMode: "full_access", sessionId: "session" });
    return module.implementation(input, { sharedState: { currentSessionId: "session" },
      executionAuthority: { toolPermissionMode: "full_access", executionIdentity: binding.identity } });
  };
  expect((await edit({ modelProfileId: "local" })).ok).toBe(true);
  expect((await service.get(job.id))?.reasoningPreference).toEqual(original);
  expect((await edit({ title: "Renamed" })).ok).toBe(true);
  expect((await service.get(job.id))?.reasoningPreference).toEqual(original);
  const beforeInvalid = await service.get(job.id);
  const invalid = await edit({ modelProfileId: "other", reasoningBudgetTokens: 64 });
  expect(invalid.ok).toBe(false);
  expect(invalid.error).toContain("reasoningBudgetTokens requires reasoningMode=budget");
  expect((await edit({ modelProfileId: " local " })).ok).toBe(false);
  expect(await service.get(job.id)).toEqual(beforeInvalid);
  // Direct API omission keeps its existing fail-closed contract.
  await expect(service.update(job.id, { modelProfileId: "other" })).rejects.toThrow();
  expect((await edit({ modelProfileId: "other" })).ok).toBe(true);
  expect(await service.get(job.id)).toMatchObject({ modelProfileId: "other" });
  expect((await service.get(job.id))?.reasoningPreference).toBeUndefined();
  const runs = await service.listRuns(job.id);
  const pending = runs.filter((run) => run.status === "pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]?.modelProfileId).toBe("other");
  expect(pending[0]?.reasoningPreference).toBeUndefined();
  expect(runs.some((run) => run.status === "cancelled" && run.reasoningPreference?.mode === "budget")).toBe(true);
  for (const reasoningMode of ["budget", "off", "server-default", "inherit"]) {
    expect((await edit({
      modelProfileId: reasoningMode, reasoningMode,
      ...(reasoningMode === "budget" ? { reasoningBudgetTokens: 64 } : {}),
    })).ok).toBe(true);
    const expected = reasoningMode === "inherit" ? undefined : {
      profileId: reasoningMode, mode: reasoningMode,
      ...(reasoningMode === "budget" ? { budgetTokens: 64 } : {}),
    };
    expect((await service.get(job.id))?.reasoningPreference).toEqual(expected);
    const nextPending = (await service.listRuns(job.id)).filter((run) => run.status === "pending");
    expect(nextPending).toHaveLength(1);
    expect(nextPending[0]?.modelProfileId).toBe(reasoningMode);
    expect(nextPending[0]?.reasoningPreference).toEqual(expected);
  }
  expect(start).not.toHaveBeenCalled();
});
