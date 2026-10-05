import type { WorkerSettledCapabilityResult } from "../../orchestration/worker-capabilities/contracts.js";
import type { WorkerCapabilityPayloadContext } from "../../orchestration/worker-capabilities/payload-contracts.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "../../context/semantic-compaction/contracts.js";
import { createRequestContextCompactionStore } from "../../context/semantic-compaction/store.js";

export const SOURCE_PROMPT =
  "Produce the requested artifact from settled evidence.";
export function settledSource(
  executionId = "execution-1",
  referenceData = "COVERED_BODY",
): WorkerSettledCapabilityResult {
  return {
    executionId,
    callId: "call-1",
    invocationAttempt: 2,
    capabilityId: "fixture.write",
    declaredEffect: "mutation",
    outcome: "succeeded",
    observedEffect: "mutation",
    summary: "Artifact written.",
    referenceData,
    references: [{ kind: "tool_target", target: "artifact.txt" }],
    adapterResult: {
      kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin",
      status: "executed",
      result: {
        ok: true,
        tool: "fixture.write",
        output: "Artifact written.",
        producedNewInformation: true,
        data: { mutationGrounding: "COVERED_BODY" },
      },
    },
  };
}

export function nativeExecutionSource(
  result: WorkerSettledCapabilityResult,
): SemanticCompactionSource {
  const content = JSON.stringify({
    role: "tool",
    toolCallId: result.executionId,
    toolName: "runtime_capability",
    content: JSON.stringify({
      kind: "runtime_execution_capability_result_v1",
      invocationAttempt: result.invocationAttempt,
      result: {
        executionId: result.executionId,
        capabilityId: result.capabilityId,
        adapterResult: result.adapterResult,
      },
    }),
  });
  return {
    sourceRef: `tool-result:${result.executionId}`,
    content,
    sourceFingerprint: hash(content),
  };
}

export function compactedSourceFixture(
  results: readonly WorkerSettledCapabilityResult[] = [settledSource()],
  overrides: Partial<SemanticCompactionCheckpoint> = {},
  sources = results.map(nativeExecutionSource),
) {
  const store = createRequestContextCompactionStore();
  store.registerSources(sources);
  const checkpoint: SemanticCompactionCheckpoint = {
    kind: "runtime_semantic_compaction_checkpoint_v2",
    requestId: "request-1",
    currentRequestFingerprint: hash(SOURCE_PROMPT),
    roleId: "supervisor",
    callId: "call-1",
    objectiveFingerprint: hash(SOURCE_PROMPT),
    contextLane: "role_continuation",
    allowedConsumers: ["execution.decision", "execution.response"],
    scopeId: "role:supervisor:call-1:continuation",
    sourceRevision: 7,
    sourceDigests: sources.map(({ sourceRef, sourceFingerprint }, index) => ({
      sourceRef,
      sourceFingerprint,
      digest: `DIGEST_${results[index]!.executionId}`,
    })),
    continuation: {
      completed: [],
      currentState: "ROOT_CONTINUATION_MUST_NOT_TRANSFER",
      findings: [],
      evidenceRefs: sources.map(({ sourceRef }) => sourceRef),
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: [],
      blockers: [],
      nextStep: "ROOT_NEXT_ACTION_MUST_NOT_TRANSFER",
    },
    ...overrides,
  };
  store.commit(checkpoint);
  return {
    store,
    checkpoint,
    sources,
    results,
    request: {
      requestId: "request-1",
      prompt: SOURCE_PROMPT,
      contextCompactionStore: store,
    },
    resolver: {
      requestId: "request-1",
      prompt: SOURCE_PROMPT,
      objective: SOURCE_PROMPT,
      callId: "call-1",
      store,
      results,
    },
  };
}

export function payloadSourceContext(
  results: readonly WorkerSettledCapabilityResult[],
): WorkerCapabilityPayloadContext {
  return {
    root: {
      callId: "call-1",
      invocationAttempt: 3,
      objectiveSource: "runtime_request_source_plus_steering_v1",
      steeringVersion: 0,
      updates: [],
    },
    contextScope: "standard",
    settledCapabilityResults: results,
    acceptedCapability: {
      capabilityId: "fixture.write",
      summary: "Write",
      authoringObjective: "Write the accepted target.",
      controls: { path: "new.txt" },
    },
    payloadContract: {
      instructions: "Author the accepted artifact.",
      minBytes: 1,
      maxBytes: 10000,
    },
  };
}
