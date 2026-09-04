import { describe, expect, test } from "vitest";

import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
import { WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP } from "../orchestration/worker-capabilities/index.js";
import { projectWorkerPayloadDependencyResults } from "../steps/worker-decision/payload-dependency-results.js";

describe("PR1 Worker payload dependency projection", () => {
  test("removes lineage receipts before the raw tool-payload boundary", () => {
    const receipt = Object.freeze({
      kind: "work_result_v1" as const,
      producerCallId: "call-2",
      callerCallId: "call-1",
      sourceRevision: 4,
      lineageFingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    const semanticCheckpoint: SemanticCompactionCheckpoint = Object.freeze({
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId: "scope:dependency",
      requestId: "request-payload-projection",
      currentRequestFingerprint:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      roleId: "worker",
      callId: "call-2",
      objectiveFingerprint:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([
        WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
      ]),
      sourceRevision: 3,
      sourceDigests: Object.freeze([]),
      continuation: Object.freeze({
        completed: Object.freeze([]),
        currentState: "The prerequisite evidence is available.",
        findings: Object.freeze([]),
        evidenceRefs: Object.freeze([]),
        artifacts: Object.freeze([]),
        decisions: Object.freeze([]),
        failedApproaches: Object.freeze([]),
        openWork: Object.freeze([]),
        blockers: Object.freeze([]),
        nextStep: "Author the selected capability payload.",
      }),
    });
    const semanticCheckpoints = Object.freeze([semanticCheckpoint]);
    const dependencies = Object.freeze([
      Object.freeze({
        resultRef: "result-1",
        producerCallId: "call-2",
        roleId: "worker" as const,
        outcome: "completed" as const,
        summary: "The prerequisite result is settled.",
        receipt,
        semanticCheckpoints,
      }),
    ]);

    const projected = projectWorkerPayloadDependencyResults(dependencies);

    expect(projected).toEqual([
      {
        resultRef: "result-1",
        producerCallId: "call-2",
        roleId: "worker",
        outcome: "completed",
        summary: "The prerequisite result is settled.",
        semanticCheckpoints,
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("work_result_v1");
    expect(projected[0]?.semanticCheckpoints).toBe(semanticCheckpoints);
    expect(dependencies[0]?.receipt).toBe(receipt);
  });
});
