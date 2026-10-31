import { afterEach, expect, test, vi } from "vitest";
import type { CompactionProgressObserver } from "../model/context-compaction-progress.js";
import { createAdmissionFixture, createAdmissionController } from "./support/compaction-admission-fixture.js";
import { createProjectionRepairStage } from "./support/compaction-projection-repair-fixture.js";
import { RuntimeEventBus } from "../events/runtime-emitter.js";
import type WebSocket from "ws";

afterEach(() => vi.restoreAllMocks());

test("progress is live, scoped to the outer admission and never commits an intermediate candidate", async () => {
  const h = createAdmissionFixture({ modelStep: "execution.decision", counts: [39545, 28708, 26000] });
  const active = createProjectionRepairStage("active_request");
  const prepare = active.prepare.getMockImplementation()!;
  const observers: CompactionProgressObserver[] = [];
  active.prepare.mockImplementation(async (messages, context) => {
    const report = context!.onProgress!;
    observers.push(report);
    report({ step: "processing", unit: "sources", completedUnits: 0, totalUnits: 3 });
    expect(active.firstCommit).not.toHaveBeenCalled();
    report({ step: "processing", unit: "sources", completedUnits: 3, totalUnits: 3 });
    if (observers.length === 2) observers[0]!({ step: "merging" });
    return prepare(messages, context);
  });
  await h.run(createAdmissionController([active]));
  const progress = h.events.filter(([name]) => name === "context.compaction.progress").map(([, data]) => data!);
  expect(progress.map(({ attempt, step }) => [attempt, step])).toEqual([
    [1, "processing"], [1, "processing"], [1, "checking"],
    [2, "processing"], [2, "processing"], [2, "checking"],
  ]);
  const started = h.events.find(([name]) => name === "context.compaction.started")![1]!;
  for (const event of progress) {
    expect(event).toMatchObject({ invocationId: started.invocationId, requestId: started.requestId, scopeId: active.scopeId });
    expect(event.progressAt).toEqual(expect.any(Number));
    expect(event.status).toContain("3");
    expect(JSON.stringify(event)).not.toContain("policy");
  }
  expect(active.firstCommit).not.toHaveBeenCalled();
  expect(active.repairCommit).toHaveBeenCalledOnce();
  expect(h.countInputTokens).toHaveBeenCalledTimes(3);
  expect(h.invoke).toHaveBeenCalledOnce();
  const count = h.events.length;
  observers[1]!({ step: "processing", completedUnits: 0, totalUnits: 3, unit: "sources" });
  expect(h.events).toHaveLength(count);
});

test.each([false, true])("progress delivery cannot change admission or cancellation (cancel=%s)", async (cancel) => {
  const h = createAdmissionFixture({ counts: [39545, 20000], onEvent: (name) => {
    if (name === "context.compaction.progress") throw new Error("broken_ui");
  } });
  const active = createProjectionRepairStage("active_request");
  const prepare = active.prepare.getMockImplementation()!;
  active.prepare.mockImplementation(async (messages, context) => {
    context!.onProgress!({ step: "processing", unit: "sources", completedUnits: 0, totalUnits: 1 });
    if (cancel) h.abort.abort(new Error("request_cancelled"));
    return prepare(messages, context);
  });
  const result = h.run(createAdmissionController([active]));
  if (cancel) {
    await expect(result).rejects.toThrow("request_cancelled");
    expect(active.firstCommit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    return;
  }
  await expect(result).resolves.toBe("ok");
  expect(active.firstCommit).toHaveBeenCalledOnce();
});

test("progress uses the ordinary sequenced, replayable event transport", async () => {
  const sent: Record<string, unknown>[] = [];
  const saved: Record<string, unknown>[] = [];
  const bus = new RuntimeEventBus({ requestId: "r", ws: { send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket,
    persist: async (payload) => { saved.push(payload); } });
  bus.event("context.compaction.progress", { invocationId: "outer", status: "Compacting context", step: "processing", completedUnits: 2, totalUnits: 3 });
  await bus.drain();
  expect(sent).toEqual(saved);
  expect(sent[0]).toMatchObject({ requestId: "r", eventSequence: 1, completedUnits: 2, totalUnits: 3 });
});
