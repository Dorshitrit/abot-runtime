import { afterEach, expect, test, vi } from "vitest";
import type { CompactionProgress } from "../model/context-compaction-progress.js";
import { generateSemanticCompactionCandidateBatched } from "../context/semantic-compaction/run.js";
import { semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { stagedSuperFixture } from "./support/super-staged-compaction-fixture.js";

afterEach(() => vi.restoreAllMocks());

test.each([false, true])("EA reports actual source/slice work without changing model input (sliced=%s)", async (sliced) => {
  const control = semanticContractFixture({ policy: "execution-agent-v1", sliced });
  const expected = await generateSemanticCompactionCandidateBatched(control.params);
  const observed = semanticContractFixture({ policy: "execution-agent-v1", sliced });
  const updates: CompactionProgress[] = [];
  const actual = await generateSemanticCompactionCandidateBatched({ ...observed.params, onProgress: (p) => updates.push(p) });
  expect(actual).toEqual(expected);
  expect(observed.captured).toEqual(control.captured);
  expect(observed.counted).toEqual(control.counted);
  expect(updates[0]).toMatchObject({ completedUnits: 0, totalUnits: 1, unit: "sources" });
  expect(updates.at(-1)).toMatchObject({ completedUnits: 1, totalUnits: 1 });
  const slices = updates.filter((p) => p.totalBytes !== undefined);
  if (!sliced) { expect(slices).toHaveLength(0); return; }
  expect(slices.length).toBeGreaterThan(2);
  expect(slices.at(-1)!.completedBytes).toBe(slices.at(-1)!.totalBytes);
  expect(slices.every((p, i) => i === 0 || p.completedBytes! >= slices[i - 1]!.completedBytes!)).toBe(true);
});

test("SUPER reports source, window and merge progress through the canonical request path", async () => {
  const f = stagedSuperFixture(false);
  await f.run();
  const updates = f.events.filter((e) => e.name === "context.compaction.progress").map((e) => e.data!);
  expect(updates.length).toBeGreaterThan(2);
  expect(updates.some((p) => p.step === "merging")).toBe(true);
  expect(updates.some((p) => p.totalBytes !== undefined)).toBe(true);
  expect(updates.some((p) => p.completedUnits === p.totalUnits && p.step === "checking")).toBe(true);
  for (const progress of updates) {
    const start = f.events.find((e) => e.name === "context.compaction.started" && e.data?.invocationId === progress.invocationId);
    expect(start).toBeDefined();
  }
});
