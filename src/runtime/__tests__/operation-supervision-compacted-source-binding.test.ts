import { afterEach, beforeEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { resolveCompactedOperationSupervisionEvidence } from "../context/operation-supervision-compacted-evidence.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import {
  compactedSourceFixture,
  nativeExecutionSource,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

function supervisionSourceFixture(
  policy: "EA" | "SUPER",
  summary?: string,
  output = summary,
) {
  const original = settledSource();
  if (original.adapterResult?.kind !== "registered_tool_execution_result_v1")
    throw new Error("expected_registered_result");
  const result = {
    ...original,
    summary: summary ?? original.summary,
    adapterResult: {
      ...original.adapterResult,
      result: {
        ...original.adapterResult.result,
        output: output ?? "Artifact written.",
      },
    },
  };
  const { adapterResult, ...receipt } = result;
  const acceptedAction = {
    executionId: result.executionId,
    capabilityId: result.capabilityId,
    controls: { path: "artifact.txt" },
    declaredEffect: result.declaredEffect,
    workingDirectory: ".",
  };
  const evidence = {
    kind: "embedded_exact_result" as const,
    receipt,
    acceptedAction,
    adapterResult,
  };
  const roleId = policy === "EA" ? "supervisor" : "worker";
  const consumer =
    policy === "EA"
      ? ("execution.decision" as const)
      : ("worker.decision" as const);
  const source =
    policy === "EA"
      ? nativeExecutionSource(result)
      : createCapabilityResultCompactionSource({ ...result, acceptedAction });
  const f = compactedSourceFixture(
    [result],
    { roleId, allowedConsumers: [consumer] },
    [source],
  );
  const context = {
    requestId: f.request.requestId,
    call: { roleId, callId: result.callId },
    sourceRevision: 8,
    consumer,
  };
  return {
    ...f,
    result,
    source,
    evidence,
    context,
    compaction: { store: f.store, checkpoint: f.checkpoint },
  };
}

test.each(["EA", "SUPER"] as const)(
  "%s supervision binds its compacted reference to exact stored source bytes",
  (policy) => {
    const f = supervisionSourceFixture(policy);
    const result = resolveCompactedOperationSupervisionEvidence(
      f.result.executionId,
      f.evidence,
      f.context,
      f.compaction,
    );
    expect(result).toMatchObject({
      kind: "compacted_capability_result_reference",
      sourceRef: f.source.sourceRef,
      sourceFingerprint: f.source.sourceFingerprint,
      acceptedAction: f.evidence.acceptedAction,
    });
    expect(result).not.toHaveProperty("adapterResult");
    expect(
      f.store.materializeSource(result!.sourceRef, result!.sourceFingerprint),
    ).toEqual(f.source);
  },
);

test.each(["EA", "SUPER"] as const)(
  "%s compacted receipt does not re-embed a full result under summary",
  (policy) => {
    const summary = "FULL_RESULT_SUMMARY:" + "source detail ".repeat(500);
    const f = supervisionSourceFixture(policy, summary);
    const sourceBefore = f.store.materializeSource(
      f.source.sourceRef,
      f.source.sourceFingerprint,
    );
    const projected = resolveCompactedOperationSupervisionEvidence(
      f.result.executionId,
      f.evidence,
      f.context,
      f.compaction,
    );
    expect(projected).toBeDefined();
    expect(projected!.receipt).toMatchObject({
      executionId: f.result.executionId,
      outcome: f.result.outcome,
      observedEffect: f.result.observedEffect,
    });
    expect(projected!.receipt.summary).not.toBe(summary);
    expect(JSON.stringify(projected)).not.toContain(summary);
    expect(f.evidence.receipt.summary).toBe(summary);
    expect(
      f.store.materializeSource(f.source.sourceRef, f.source.sourceFingerprint),
    ).toEqual(sourceBefore);
  },
);

test.each(["EA", "SUPER"] as const)(
  "%s preserves independent summary supplements after result compaction",
  (policy) => {
    for (const summary of [
      "Output with a caveat.",
      "Full output",
      "Full output\n",
    ]) {
      const f = supervisionSourceFixture(policy, summary, "Full output ");
      const projected = resolveCompactedOperationSupervisionEvidence(
        f.result.executionId,
        f.evidence,
        f.context,
        f.compaction,
      );
      expect(projected!.receipt.summary).toBe(summary);
    }
  },
);

test.each(["EA", "SUPER"] as const)(
  "%s supervision does not borrow a different call, request, revision, consumer or source",
  (policy) => {
    const f = supervisionSourceFixture(policy);
    const changedContexts = [
      { ...f.context, requestId: "other-request" },
      { ...f.context, call: { ...f.context.call, callId: "other-call" } },
      { ...f.context, call: { ...f.context.call, roleId: "other-role" } },
      { ...f.context, sourceRevision: f.checkpoint.sourceRevision - 1 },
      { ...f.context, consumer: "tool_payload.raw" as const },
      { ...f.context, consumer: undefined },
    ];
    for (const context of changedContexts)
      expect(
        resolveCompactedOperationSupervisionEvidence(
          f.result.executionId,
          f.evidence,
          context,
          f.compaction,
        ),
      ).toBeUndefined();
    expect(
      resolveCompactedOperationSupervisionEvidence(
        "another-execution",
        f.evidence,
        f.context,
        f.compaction,
      ),
    ).toBeUndefined();
    const stale = {
      ...f.checkpoint,
      sourceDigests: f.checkpoint.sourceDigests.map((source) => ({
        ...source,
        sourceFingerprint: hash("stale"),
      })),
    };
    expect(
      resolveCompactedOperationSupervisionEvidence(
        f.result.executionId,
        f.evidence,
        f.context,
        { ...f.compaction, checkpoint: stale },
      ),
    ).toBeUndefined();
    expect(
      resolveCompactedOperationSupervisionEvidence(
        f.result.executionId,
        {
          ...f.evidence,
          receipt: { ...f.evidence.receipt, invocationAttempt: 9 },
        },
        f.context,
        f.compaction,
      ),
    ).toBeUndefined();
    expect(
      resolveCompactedOperationSupervisionEvidence(
        f.result.executionId,
        f.evidence,
        f.context,
        undefined,
      ),
    ).toBeUndefined();
  },
);
