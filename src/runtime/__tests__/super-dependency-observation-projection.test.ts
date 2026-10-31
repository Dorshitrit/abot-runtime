import { describe, expect, test } from "vitest";
import {
  projectSelectedDependencyObservations,
  projectSuperDependencyObservations,
  assertBoundDependencyObservations,
} from "../context/super-dependency-observations.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { projectRoleCallDependencyResults } from "../orchestration/role-calls/index.js";
import {
  cloneDependencyHead,
  dependencyObservationFixture,
  NESTED_SOURCE,
  SELECTED_SOURCE,
  UNSELECTED_SOURCE,
} from "./support/super-dependency-observation-fixture.js";

describe("selected SUPER dependency observations", () => {
  test("follows selected transitive receipts and child observations, excluding an unrelated sibling", async () => {
    const f = await dependencyObservationFixture();
    const before = JSON.stringify(f.head);
    const results = projectSelectedDependencyObservations(f.head, f.call);
    expect(results.map(result => result.executionId)).toEqual([f.firstExecutionId, f.nestedExecutionId]);
    expect(results.map(result => result.callId)).toEqual([f.firstProducer.callId, f.nestedProducer.callId]);
    expect(results.every(result => result.declaredEffect === "mixed" && result.observedEffect === "observation")).toBe(true);
    const projected = projectSuperDependencyObservations(f.head, f.call, f.dependencyResults);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
    expect(serialized).toContain("NESTED_SELECTED_TOOL_ONLY");
    expect(serialized).not.toContain(UNSELECTED_SOURCE);
    expect(projected[0]!.observations).toEqual(results);
    expect(JSON.stringify(f.head)).toBe(before);
  });

  test("preserves exact producer action/result bytes and compaction fingerprint", async () => {
    const f = await dependencyObservationFixture();
    for (const result of projectSelectedDependencyObservations(f.head, f.call)) {
      const execution = f.head.state.capabilityExecutions.find(item => item.executionId === result.executionId)!;
      const original = projectCanonicalRequestToolResult(f.head, execution);
      expect(result).toEqual(original);
      expect(result.acceptedAction).toEqual(original.acceptedAction);
      expect(result.adapterResult).toEqual(original.adapterResult);
      expect(createCapabilityResultCompactionSource(result)).toEqual(createCapabilityResultCompactionSource(original));
      if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
        throw new Error("expected_registered_observation");
      expect(result.adapterResult.result.stdout).toBe(
        result.executionId === f.firstExecutionId ? SELECTED_SOURCE : NESTED_SOURCE,
      );
    }
  });

  test("an observation reachable from two selected receipts appears once", async () => {
    const f = await dependencyObservationFixture({ selectFirstDirectly: true });
    const projected = projectSuperDependencyObservations(f.head, f.call, f.dependencyResults);
    expect(projected.flatMap(result => result.observations ?? []).map(result => result.executionId))
      .toEqual([f.firstExecutionId, f.nestedExecutionId]);
    expect(projected[1]).toBe(f.dependencyResults[1]);
    expect(JSON.stringify(projected).split("SELECTED_TRANSITIVE_TOOL_ONLY")).toHaveLength(2);
  });

  test.each(["mutation", "none"] as const)("does not transfer a selected result whose actual effect is %s", async observedEffect => {
    const f = await dependencyObservationFixture({ first: { observedEffect } });
    expect(projectSelectedDependencyObservations(f.head, f.call).map(result => result.executionId))
      .toEqual([f.nestedExecutionId]);
  });

  test("retains failed observations as failed evidence without asserting success", async () => {
    const f = await dependencyObservationFixture({ first: { outcome: "failed" } });
    const result = projectSelectedDependencyObservations(f.head, f.call)[0]!;
    expect(result).toMatchObject({ executionId: f.firstExecutionId, declaredEffect: "mixed",
      observedEffect: "observation", outcome: "failed" });
    expect(result.adapterResult).toMatchObject({ result: { ok: false, exitCode: 1, stdout: SELECTED_SOURCE } });
  });

  test("a failed operation with no observed effect is not promoted into observation evidence", async () => {
    const f = await dependencyObservationFixture({ first: { outcome: "failed", observedEffect: "none" } });
    expect(projectSelectedDependencyObservations(f.head, f.call).map(result => result.executionId))
      .toEqual([f.nestedExecutionId]);
  });

  test("rejects a result reference the consumer never selected", async () => {
    const f = await dependencyObservationFixture();
    expect(() => projectSelectedDependencyObservations(f.head, f.call, f.unselectedResult.resultRef)).toThrow();
  });

  test("rejects a forged canonical receipt instead of using its plausible summary", async () => {
    const f = await dependencyObservationFixture();
    const head = cloneDependencyHead(f.head);
    const result = head.state.results.find(item => item.resultRef === f.selectedResult.resultRef)!;
    Reflect.set(result.receipt!, "lineageFingerprint", "sha256:forged-lineage");
    const call = head.state.calls.find(item => item.callId === f.call.callId)!;
    expect(() => projectSelectedDependencyObservations(head, call)).toThrow();
  });

  test("rejects a missing receipt for the selected transitive producer", async () => {
    const f = await dependencyObservationFixture();
    const head = cloneDependencyHead(f.head);
    const result = head.state.results.find(item => item.resultRef === f.firstResult.resultRef)!;
    Reflect.deleteProperty(result, "receipt");
    const call = head.state.calls.find(item => item.callId === f.call.callId)!;
    expect(() => projectSelectedDependencyObservations(head, call)).toThrow();
  });

  test("rejects a changed child-parent lineage", async () => {
    const f = await dependencyObservationFixture();
    const head = cloneDependencyHead(f.head);
    const child = head.state.calls.find(item => item.callId === f.nestedProducer.callId)!;
    Reflect.set(child, "parentCallId", f.unselectedProducer.callId);
    const call = head.state.calls.find(item => item.callId === f.call.callId)!;
    expect(() => projectSelectedDependencyObservations(head, call)).toThrow();
  });

  test.each(["executionId", "callId", "summary"] as const)("rejects a payload observation with forged %s", async field => {
    const f = await dependencyObservationFixture();
    const valid = projectSuperDependencyObservations(f.head, f.call, f.dependencyResults);
    expect(() => assertBoundDependencyObservations(f.head, f.call, valid)).not.toThrow();
    const observation = valid[0]!.observations![0]!;
    const forged = [{ ...valid[0]!, observations: [{ ...observation, [field]: "forged-value" }] }];
    expect(() => assertBoundDependencyObservations(f.head, f.call, forged)).toThrow();
  });

  test("rejects altered stdout and duplicate source execution IDs", async () => {
    const f = await dependencyObservationFixture();
    const valid = projectSuperDependencyObservations(f.head, f.call, f.dependencyResults);
    const observation = valid[0]!.observations![0]!;
    const adapter = observation.adapterResult;
    if (adapter?.kind !== "registered_tool_execution_result_v1") throw new Error("expected_registered_observation");
    const altered = { ...observation, adapterResult: { ...adapter, result: { ...adapter.result, stdout: "fabricated source" } } };
    const alteredDependency = { ...valid[0]!, observations: [altered] };
    const duplicatedDependency = { ...valid[0]!, observations: [observation, observation] };
    expect(() => assertBoundDependencyObservations(f.head, f.call, [alteredDependency])).toThrow();
    expect(() => assertBoundDependencyObservations(f.head, f.call, [duplicatedDependency])).toThrow();
  });

  test("keeps dependency projection identity for EA authority", async () => {
    const f = await dependencyObservationFixture();
    const head = cloneDependencyHead(f.head);
    Reflect.set(head.policy, "authority", resolveRequestExecutionPolicy("execution-agent-v1").authority);
    const call = head.state.calls.find(item => item.callId === f.call.callId)!;
    expect(projectSelectedDependencyObservations(head, call)).toEqual([]);
    expect(projectSuperDependencyObservations(head, call, f.dependencyResults)).toBe(f.dependencyResults);
  });

  test("keeps summary-only dependency identity without imposing a new receipt requirement", async () => {
    const f = await dependencyObservationFixture({ first: { observedEffect: "none" }, nested: { observedEffect: "mutation" } });
    const head = cloneDependencyHead(f.head);
    for (const result of head.state.results) Reflect.deleteProperty(result, "receipt");
    const call = head.state.calls.find(item => item.callId === f.call.callId)!;
    const original = projectRoleCallDependencyResults(head, call);
    expect(projectSelectedDependencyObservations(head, call)).toEqual([]);
    expect(projectSuperDependencyObservations(head, call, original)).toBe(original);
  });
});
