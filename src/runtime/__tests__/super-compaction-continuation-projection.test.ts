import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { projectSuperContinuation } from "../context/super-compaction/continuation-projection.js";
import { createPolicyModelStepCompactionController } from "../context/super-compaction/routing.js";
import { projectCheckpointMessages } from "../context/model-step-compaction-projection.js";
import { buildCheckpointMessage } from "../context/semantic-compaction/checkpoint-message.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/contracts.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/contracts.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";

const prompt = "Investigate deployment";
const objective = "Explain the recorded deployment state";
const source = {
  sourceRef: "receipt-1",
  content: "Selected test failed; deployment is pending.",
  sourceFingerprint: createSemanticCompactionSha256Fingerprint(
    "Selected test failed; deployment is pending.",
  ),
};
const checkpoint: SemanticCompactionCheckpoint = {
  kind: "runtime_semantic_compaction_checkpoint_v2",
  scopeId: "worker:handoff",
  requestId: "raw-handoff",
  currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(prompt),
  roleId: "worker",
  callId: "call-1",
  objectiveFingerprint: createSemanticCompactionSha256Fingerprint(objective),
  contextLane: "role_continuation",
  allowedConsumers: ["worker.result"],
  sourceRevision: 1,
  sourceDigests: [
    {
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: source.content,
    },
  ],
  continuation: createSuperContinuation(source.content),
};

function readProjection(message: ChatMessage) {
  const json = message.content.replace(/^Canonical runtime context:\n/u, "");
  const decoded = JSON.parse(json);
  return decoded.semanticCheckpoint ?? decoded;
}

const carriers: ReadonlyArray<readonly [string, readonly ChatMessage[]]> = [
  ["standalone", []],
  [
    "tool results",
    [
      {
        role: "user",
        content: JSON.stringify({
          kind: "runtime_request_tool_results_v1",
          results: [],
        }),
      },
    ],
  ],
  [
    "payload",
    [
      {
        role: "user",
        content:
          "Canonical runtime context:\n" +
          JSON.stringify({ settledCapabilityResults: [] }),
      },
    ],
  ],
];

describe("SUPER continuation presentation", () => {
  test("preserves nonempty legacy fields without asserting empty categories", () => {
    const legacy = {
      ...checkpoint.continuation,
      completed: ["Inspected service state"],
      findings: ["The health check failed"],
      evidenceRefs: ["receipt-1"],
      artifacts: ["diagnostic.txt"],
      decisions: ["Keep deployment paused"],
      failedApproaches: ["Initial restart did not recover"],
      openWork: ["Resolve the recorded failing check"],
      blockers: ["The health check is still failing"],
      nextStep: "Inspect the recorded failing condition",
    };
    const projected = projectSuperContinuation(legacy);
    expect(projected.kind).toBe("runtime_super_raw_handoff_v1");
    for (const value of Object.values(legacy)) {
      const values = typeof value === "string" ? [value] : value;
      for (const entry of values) expect(projected.text).toContain(entry);
    }
    expect(projected).not.toHaveProperty("openWork");
    expect(projected).not.toHaveProperty("findings");
    expect(
      JSON.parse(
        buildCheckpointMessage({ ...checkpoint, continuation: legacy }).content,
      ).continuation,
    ).toEqual(legacy);
  });

  test.each(carriers)(
    "uses the same RAW projection in the %s carrier",
    (_name, messages) => {
      const options = { projectContinuation: projectSuperContinuation };
      const output = projectCheckpointMessages(
        messages,
        checkpoint.scopeId,
        checkpoint,
        new Map(),
        false,
        undefined,
        options,
      );
      const projected = readProjection(output[0]!);
      expect(projected.continuation).toEqual(
        projectSuperContinuation(checkpoint.continuation),
      );
      expect(projected.continuation.text).toContain(source.content);
      expect(projected.continuation).not.toHaveProperty("openWork");
      expect(projected.coveredSources[0].sourceRef).toBe(source.sourceRef);
      const evidenceOnly = projectCheckpointMessages(
        messages,
        checkpoint.scopeId,
        checkpoint,
        new Map(),
        false,
        undefined,
        { ...options, includeContinuation: false },
      );
      expect(readProjection(evidenceOnly[0]!)).not.toHaveProperty(
        "continuation",
      );
    },
  );

  test("restored SUPER projects RAW while EA keeps the unchanged structured checkpoint", () => {
    const request = createCompactionRequest({
      requestId: checkpoint.requestId,
      prompt,
      invoke: vi.fn(),
    });
    request.contextCompactionStore!.registerSources([source]);
    request.contextCompactionStore!.commit(checkpoint);
    const restored = restoreRequestContextCompaction(
      captureRequestContextCompaction(request.contextCompactionStore!),
    );
    const bound = { ...request, contextCompactionStore: restored };
    const options = {
      call: { roleId: "worker", callId: "call-1", objective },
      scopeId: checkpoint.scopeId,
      sourceRevision: 1,
      allowedConsumers: checkpoint.allowedConsumers,
      consumer: "worker.result" as const,
    };
    const superOutput = createPolicyModelStepCompactionController(
      bound,
      options,
      SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    ).project([]);
    const eaOutput = createPolicyModelStepCompactionController(
      bound,
      options,
      EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
    ).project([]);
    expect(readProjection(superOutput[0]!).continuation).toEqual(
      projectSuperContinuation(checkpoint.continuation),
    );
    expect(readProjection(eaOutput[0]!).continuation).toEqual(
      checkpoint.continuation,
    );
    expect(restored.get(checkpoint.scopeId)).toEqual(checkpoint);
  });
});
