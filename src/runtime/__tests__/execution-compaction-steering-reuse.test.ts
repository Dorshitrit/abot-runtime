import { afterEach, beforeEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { projectExecutionPayloadCompactedEvidence } from "../request/execution-payload-compacted-evidence.js";
import { buildExecutionControlsEvidenceMessage } from "../steps/execution-agent/controls-compacted-evidence.js";
import { projectAuditorAssignment } from "../steps/auditor-decision/projection.js";
import { encodeExecutionAgentAuditObjective } from "../steps/auditor-decision/contracts.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";
import { activeEvidenceCall } from "./support/execution-controls-evidence-fixture.js";
import { payloadSourceContext } from "./support/compacted-execution-source-fixture.js";
import {
  executionCompactionSteeringFixture,
  STEERED_FACT,
  STEERED_CONTINUATION,
} from "./support/execution-compaction-steering-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test.each([false, true])(
  "EA producer reuses the accepted steering objective across selected consumers (response=%s)",
  async (response) => {
    const f = await executionCompactionSteeringFixture();
    f.steering.append({
      steerId: "accepted",
      text: "Compare the verified values.",
    });
    const accepted = f.steering.snapshot();
    await f.run(response);
    const checkpoint = f.request.contextCompactionStore!.findByCallIds([
      "call-1",
    ])[0]!;
    expect(checkpoint).toBeDefined();
    await f.addResult("FRESH_UNCOMPACTED_EVIDENCE", { target: "fresh.txt" });
    // Downstream operations keep their accepted steering prefix when a newer update arrives.
    f.steering.append({
      steerId: "later",
      text: "Use a different comparison.",
    });
    // A newer committed checkpoint cannot expand this already accepted assignment.
    await f.run(response);
    expect(f.request.contextCompactionStore!.findByCallIds(["call-1"]))
      .toHaveLength(2);
    const view = f.view();
    const results = view.results as readonly WorkerSettledCapabilityResult[];
    const context = payloadSourceContext(results);
    if (!("root" in context)) throw new Error("root_context_required");
    const projected = projectExecutionPayloadCompactedEvidence(
      f.request,
      {
        ...context,
        root: {
          ...context.root,
          steeringVersion: accepted.version,
          updates: accepted.updates,
        },
      },
      results,
    );
    expect(projected.evidence?.sources).toEqual([
      expect.objectContaining({
        executionId: f.executionId,
        digest: STEERED_FACT,
      }),
    ]);
    expect(projected.results[0]).not.toHaveProperty("adapterResult");
    expect(projected.results[1]).toEqual(results[1]);
    const controls = JSON.parse(
      buildExecutionControlsEvidenceMessage(view, {
        requestId: f.request.requestId,
        callId: "call-1",
        steering: accepted,
        compaction: {
          prompt: f.request.prompt,
          store: f.request.contextCompactionStore,
        },
      }).content,
    );
    expect(controls.compactedSourceEvidence.sources).toEqual(
      projected.evidence!.sources,
    );
    expect(controls.results[0]).not.toHaveProperty("adapterResult");
    expect(controls.results[1].adapterResult).toEqual(
      results[1]!.adapterResult,
    );
    await f.commit({
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "reviewer",
      objective: encodeExecutionAgentAuditObjective(
        ["request_completion"],
        accepted.version,
      ),
    });
    const head = f.ledger.current();
    const audit = projectAuditorAssignment(
      f.request,
      head,
      activeEvidenceCall(head),
    );
    expect(audit.compactedSourceEvidence?.sources).toEqual(
      projected.evidence!.sources,
    );
    expect(audit.inventory[0]?.evidencePresentation).toBe("compacted");
    expect(audit.inventory[1]?.evidencePresentation).toBeUndefined();
  },
);

test("changed objective reuses verified evidence without generating or rebinding the old checkpoint", async () => {
  const f = await executionCompactionSteeringFixture();
  await f.run();
  const oldCheckpoint = f.request.contextCompactionStore!.findByCallIds([
    "call-1",
  ])[0]!;
  f.steering.append({
    steerId: "changed",
    text: "Compare a different attribute.",
  });
  const snapshot = f.steering.snapshot();
  const view = f.view();
  const controls = JSON.parse(
    buildExecutionControlsEvidenceMessage(view, {
      requestId: f.request.requestId,
      callId: "call-1",
      steering: snapshot,
      compaction: {
        prompt: f.request.prompt,
        store: f.request.contextCompactionStore,
      },
    }).content,
  );
  expect(controls.compactedSourceEvidence.sources).toEqual([
    expect.objectContaining({ executionId: f.executionId, digest: STEERED_FACT }),
  ]);
  expect(controls.results[0]).not.toHaveProperty("adapterResult");
  f.invoke.mockClear();
  await f.run();
  const checkpoints = f.request.contextCompactionStore!.findByCallIds([
    "call-1",
  ]);
  expect(checkpoints).toContainEqual(oldCheckpoint);
  expect(checkpoints).toEqual([oldCheckpoint]);
  expect(
    f.invoke.mock.calls.some(
      ([input]) => input.modelStep === "context.compact",
    ),
  ).toBe(false);
});

test.each([
  { response: false, boundary: "provider", step: "execution.decision" },
  { response: true, boundary: "provider", step: "execution.response" },
  { response: false, boundary: "compaction", step: "context.compact" },
  { response: true, boundary: "compaction", step: "context.compact" },
])(
  "steering during $boundary returns EA response=$response to root ownership instead of retrying the frozen controller",
  async ({ response, boundary, step }) => {
    const f = await executionCompactionSteeringFixture();
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (input) => {
      const result = await invoke(input);
      if (input.modelStep === step)
        f.steering.append({
          steerId: "in-flight",
          text: "Change the accepted objective.",
        });
      return result;
    });
    await expect(f.run(response)).rejects.toBeInstanceOf(
      ModelStepSteeringSupersededError,
    );
    expect(
      f.invoke.mock.calls.filter(
        ([input]) => input.modelStep !== "context.compact",
      ),
    ).toHaveLength(boundary === "provider" ? 1 : 0);
    const before = f.request.contextCompactionStore!.findByCallIds(["call-1"]);
    expect(before).toHaveLength(boundary === "provider" ? 1 : 0);
    f.invoke.mockImplementation(invoke);
    f.invoke.mockClear();
    await f.run(response);
    const after = f.request.contextCompactionStore!.findByCallIds(["call-1"]);
    expect(after).toHaveLength(1);
    expect(
      f.invoke.mock.calls.filter(
        ([input]) => input.modelStep === "context.compact",
      ),
    ).toHaveLength(boundary === "provider" ? 0 : 1);
    for (const checkpoint of before) expect(after).toContainEqual(checkpoint);
  },
);

test("all downstream consumers reuse source evidence across accepted steering without the old continuation", async () => {
  const f = await executionCompactionSteeringFixture();
  await f.run();
  f.steering.append({
    steerId: "changed",
    text: "Analyze a different attribute.",
  });
  const accepted = f.steering.snapshot();
  const view = f.view();
  const results = view.results as readonly WorkerSettledCapabilityResult[];
  const context = payloadSourceContext(results);
  if (!("root" in context)) throw new Error("root_context_required");
  const payload = projectExecutionPayloadCompactedEvidence(
    f.request,
    {
      ...context,
      root: {
        ...context.root,
        steeringVersion: accepted.version,
        updates: accepted.updates,
      },
    },
    results,
  );
  expect(payload.evidence?.sources).toEqual([
    expect.objectContaining({ executionId: f.executionId, digest: STEERED_FACT }),
  ]);
  expect(payload.results[0]).not.toHaveProperty("adapterResult");
  const controls = JSON.parse(
    buildExecutionControlsEvidenceMessage(view, {
      requestId: f.request.requestId,
      callId: "call-1",
      steering: accepted,
      compaction: {
        prompt: f.request.prompt,
        store: f.request.contextCompactionStore,
      },
    }).content,
  );
  expect(controls.compactedSourceEvidence.sources).toEqual(
    payload.evidence!.sources,
  );
  expect(controls.results[0]).not.toHaveProperty("adapterResult");
  await f.commit({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: encodeExecutionAgentAuditObjective(
      ["request_completion"],
      accepted.version,
    ),
  });
  const head = f.ledger.current();
  const audit = projectAuditorAssignment(
    f.request,
    head,
    activeEvidenceCall(head),
  );
  expect(audit.compactedSourceEvidence?.sources).toEqual(
    payload.evidence!.sources,
  );
  expect(audit.inventory[0]?.evidencePresentation).toBe("compacted");
  for (const evidence of [payload.evidence, controls, audit]) {
    expect(JSON.stringify(evidence)).not.toContain(STEERED_CONTINUATION);
  }
});
