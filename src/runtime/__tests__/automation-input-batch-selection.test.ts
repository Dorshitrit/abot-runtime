import { expect, test } from "vitest";
import { selectAutomationInputBatch } from "../automations/input-batch-selection.js";

function files(sizes: readonly number[]) {
  return sizes.map((size, id) => ({ id, file: { sizeBytes: size * 1024 * 1024 } }));
}

test.each([
  { sizes: [10, 10, 10, 5, 1], expected: [0, 1, 2, 4] },
  { sizes: [10, 10, 10, 5, 5, 5], expected: [0, 3, 4, 5] },
])("selects a feasible threshold batch from $sizes", ({ sizes, expected }) => {
  const candidates = files(sizes);
  const selected = selectAutomationInputBatch(candidates, 4, 10);
  expect(selected.map((item) => item.id)).toEqual(expected);
  expect(selected.reduce((bytes, item) => bytes + item.file.sizeBytes, 0))
    .toBeLessThanOrEqual(32 * 1024 * 1024);
});

test("preserves normal source order and leaves overflow unclaimed", () => {
  const candidates = files([10, 10, 10, 1]);
  expect(selectAutomationInputBatch(candidates, 2, 2)).toEqual(candidates.slice(0, 2));
  expect(candidates.map((item) => item.id)).toEqual([0, 1, 2, 3]);
  expect(selectAutomationInputBatch(candidates.slice(0, 1), 2, 2)).toEqual([]);
  expect(() => selectAutomationInputBatch(candidates, 4, 3))
    .toThrow("automation_source_capacity_exceeded");
  expect(() => selectAutomationInputBatch(files([10, 10, 10, 10]), 4, 10))
    .toThrow("automation_source_capacity_exceeded");
});

test("agrees with an independent subset feasibility oracle across bounded queues", () => {
  for (let queue = 0; queue < 256; queue += 1) {
    const sizes = [0, 1, 2, 3].map((position) => [1, 5, 9, 10][(queue >> (position * 2)) & 3]!);
    const candidates = files([...sizes, 5, 1]);
    const minimum = queue % 2 ? 4 : 5;
    const canFit = Array.from({ length: 1 << candidates.length }, (_, mask) =>
      candidates.filter((_, index) => (mask & (1 << index)) !== 0))
      .some((subset) => subset.length === minimum &&
        subset.reduce((bytes, item) => bytes + item.file.sizeBytes, 0) <= 32 * 1024 * 1024);
    if (!canFit) {
      expect(() => selectAutomationInputBatch(candidates, minimum, 5))
        .toThrow("automation_source_capacity_exceeded");
      continue;
    }
    const selected = selectAutomationInputBatch(candidates, minimum, 5);
    expect(selected.length).toBeGreaterThanOrEqual(minimum);
    expect(selected.length).toBeLessThanOrEqual(5);
    expect(new Set(selected).size).toBe(selected.length);
    expect(selected.reduce((bytes, item) => bytes + item.file.sizeBytes, 0))
      .toBeLessThanOrEqual(32 * 1024 * 1024);
  }
});
