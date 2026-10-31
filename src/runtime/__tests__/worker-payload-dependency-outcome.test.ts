import { describe, expect, test } from "vitest";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import { isWorkerPayloadDependencyContextValid } from "../orchestration/worker-capabilities/payload-dependency-validation.js";
import { projectWorkerPayloadDependencyResults } from "../steps/worker-decision/payload-dependency-results.js";

type DependencyResults = Parameters<
  typeof isWorkerPayloadDependencyContextValid
>[0];
const call: RoleCallFrame = Object.freeze({
  callId: "call-3",
  parentCallId: "call-1",
  roleId: "worker",
  depth: 1,
  objective: "Complete the replacement assignment.",
  dependencyResultRefs: Object.freeze(["result-1"]),
  status: "active",
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});
const dependency = Object.freeze({
  resultRef: "result-1",
  producerCallId: "call-2",
  roleId: "worker" as const,
  outcome: "yielded" as const,
  summary: "The prior Worker returned control after a user update.",
});

describe("Worker payload dependency outcomes", () => {
  test("accepts the projected yielded Worker without adding steering authority", () => {
    const projected = projectWorkerPayloadDependencyResults([
      { ...dependency, steeringVersion: 1 },
    ]);
    expect(projected[0]).toEqual(dependency);
    expect(isWorkerPayloadDependencyContextValid(projected, call)).toBe(true);
  });

  test.each([
    ["worker", "completed"],
    ["worker", "failed"],
    ["planner", "completed"],
    ["planner", "failed"],
    ["reviewer", "completed"],
    ["reviewer", "failed"],
  ] as const)("preserves %s %s dependencies", (roleId, outcome) => {
    expect(
      isWorkerPayloadDependencyContextValid(
        [{ ...dependency, roleId, outcome }],
        call,
      ),
    ).toBe(true);
  });

  test.each(["planner", "reviewer"] as const)(
    "rejects yielded %s results",
    (roleId) => {
      expect(
        isWorkerPayloadDependencyContextValid(
          [{ ...dependency, roleId }],
          call,
        ),
      ).toBe(false);
    },
  );

  test.each([
    { outcome: "succeeded" },
    { outcome: "unknown" },
    { outcome: null },
    { roleId: "supervisor" },
    { resultRef: "result-unbound" },
    { producerCallId: "" },
    { summary: "" },
    { producerObjective: "" },
    { steeringVersion: 1 },
    { semanticCheckpoints: [] },
  ])("retains rejection for malformed dependency %j", (change) => {
    const results = [
      { ...dependency, ...change },
    ] as unknown as DependencyResults;
    expect(isWorkerPayloadDependencyContextValid(results, call)).toBe(false);
  });

  test("keeps exact dependency count and order bound to the consuming call", () => {
    expect(isWorkerPayloadDependencyContextValid(undefined, call)).toBe(false);
    const second = {
      ...dependency,
      resultRef: "result-2",
      producerCallId: "call-4",
    };
    const withTwo = { ...call, dependencyResultRefs: ["result-1", "result-2"] };
    expect(
      isWorkerPayloadDependencyContextValid([dependency, second], withTwo),
    ).toBe(true);
    expect(
      isWorkerPayloadDependencyContextValid([second, dependency], withTwo),
    ).toBe(false);
  });
});
