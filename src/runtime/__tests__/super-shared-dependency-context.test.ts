import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { projectUnsharedSuperDependencyResults, projectSuperDependencyObservations } from "../context/super-dependency-observations.js";
import { projectSemanticCompactionDependencyResults } from "../context/semantic-compaction/dependency-results.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { dependencyObservationFixture } from "./support/super-dependency-observation-fixture.js";
import { createDependencyCheckpoints } from "./support/super-dependency-compaction-fixture.js";

async function fixture() {
  const state = await dependencyObservationFixture();
  const { store } = createDependencyCheckpoints(state);
  const dependencies = projectSemanticCompactionDependencyResults({ ...state, consumer: "capability.controls", store });
  const binding = { callId: state.call.callId, invocationAttempt: state.call.activationCount };
  const shared: ChatMessage = { role: "user", content: JSON.stringify({
    kind: "runtime_worker_assignment", ...binding, dependencyResults: dependencies,
  }) };
  return { state, dependencies, binding, shared, authority: state.head.policy.authority };
}

test("Controls reuses an identical checkpoint-only dependency row from its accepted assignment", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.dependencies);
  expect(f.dependencies[0]!.semanticCheckpoints!.length).toBeGreaterThan(0);
  expect(f.dependencies[0]!.observations).toBeUndefined();
  expect(projectUnsharedSuperDependencyResults(f.dependencies, [f.shared], f.authority, f.binding)).toEqual([]);
  expect(JSON.stringify(f.dependencies)).toBe(before);
  expect(JSON.parse(f.shared.content).dependencyResults).toEqual(f.dependencies);
});

test.each(["summary", "resultRef", "producerCallId", "checkpoint"] as const)(
  "Controls retains a dependency with changed %s instead of hiding new information", async field => {
    const f = await fixture();
    const original = f.dependencies[0]!;
    const changed = field === "checkpoint"
      ? { ...original, semanticCheckpoints: original.semanticCheckpoints!.map(checkpoint => ({
        ...checkpoint, continuation: { ...checkpoint.continuation, currentState: "A newer known state." },
      })) }
      : { ...original, [field]: "changed-" + field };
    const dependencies = [changed];
    expect(projectUnsharedSuperDependencyResults(dependencies, [f.shared], f.authority, f.binding)).toBe(dependencies);
  },
);

test.each(["callId", "invocationAttempt", "kind", "role"] as const)(
  "Controls does not borrow dependency context from a mismatched %s", async field => {
    const f = await fixture();
    const record = JSON.parse(f.shared.content);
    const shared: ChatMessage = field === "role" ? { ...f.shared, role: "system" }
      : { ...f.shared, content: JSON.stringify({ ...record,
        [field]: field === "invocationAttempt" ? f.binding.invocationAttempt + 1 : "unrelated",
      }) };
    expect(projectUnsharedSuperDependencyResults(f.dependencies, [shared], f.authority, f.binding)).toBe(f.dependencies);
  },
);

test("Controls keeps an unmatched observation while reusing only exact shared bodies", async () => {
  const f = await fixture();
  const dependencies = projectSuperDependencyObservations(f.state.head, f.state.call, f.state.dependencyResults);
  const first = dependencies[0]!;
  expect(first.observations).toHaveLength(2);
  const shared: ChatMessage = { role: "user", content: JSON.stringify({
    kind: "runtime_worker_assignment", ...f.binding,
    dependencyResults: [{ ...first, observations: first.observations!.slice(0, 1) }],
  }) };
  const projected = projectUnsharedSuperDependencyResults(dependencies, [shared], f.authority, f.binding);
  expect(projected).toEqual([{ ...first, observations: first.observations!.slice(1) }]);
  expect(projected[0]!.resultRef).toBe(first.resultRef);
  expect(first.observations).toHaveLength(2);
});

test.each(["execution-agent-v1", undefined] as const)(
  "%s preserves the exact original dependency projection", async policy => {
    const f = await fixture();
    const authority = policy ? resolveRequestExecutionPolicy(policy).authority : undefined;
    expect(projectUnsharedSuperDependencyResults(f.dependencies, [f.shared], authority, f.binding)).toBe(f.dependencies);
  },
);
