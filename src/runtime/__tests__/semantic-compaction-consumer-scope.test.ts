import { expect, test } from "vitest";
import {
  captureRequestTemporalContext,
  buildRequestTemporalContextMessage,
} from "../context/request-temporal-context.js";
import { createRootCompactionFixture } from "./support/root-compaction-fixture.js";
import {
  buildCompactedRequestToolResultsMessage,
  buildRequestToolResultsMessage,
} from "../context/request-tool-results.js";
import { projectSemanticCompactionDependencyResults } from "../context/semantic-compaction/dependency-results.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "../context/semantic-compaction/evidence-scope.js";
import { projectSuperContinuation } from "../context/super-compaction/continuation-projection.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  mixedWorkerFixture,
  commit,
} from "./support/super-mixed-compaction-fixture.js";

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "A03: %s retains its canonical time capsule through history and active compaction",
  async (policy) => {
    const temporalContext = captureRequestTemporalContext({
      instant: new Date("2026-10-02T17:32:16Z"),
      timeZone: "Asia/Jerusalem",
    });
    const capsule = buildRequestTemporalContextMessage(temporalContext);
    for (const response of [false, true]) {
      const fixture = await createRootCompactionFixture(policy, {
        response,
        temporalContext,
      });
      await fixture.run();
      expect(fixture.counts.map(({ inputTokens }) => inputTokens)).toEqual(fixture.pressureCounts);
      const before = fixture.counts[0]!.messages.filter(
        ({ content }) => content === capsule.content,
      );
      // The existing presentation phase does not receive the decision's clock capsule.
      expect(before).toEqual(response ? [] : [capsule]);
      expect(
        fixture.rootInputs[0]!.filter(
          ({ content }) => content === capsule.content,
        ),
      ).toEqual(before);
      const activeCompactors = fixture.modelInputs.filter(({ step, messages }) => {
        if (policy === "execution-agent-v1")
          return step === "context.compact" && messages.some(({ content }) =>
            content.includes("runtime_semantic_compaction_input_v2"),
          );
        if (!step.startsWith("super.compact.")) return false;
        const { baseCapsule } = JSON.parse(messages.find(({ role }) => role === "user")!.content);
        return baseCapsule.authority === "settled_evidence" ||
          baseCapsule.sourceAuthority === "settled_evidence";
      });
      expect(activeCompactors.length).toBeGreaterThan(0);
      expect(JSON.stringify(activeCompactors)).not.toContain(
        temporalContext.currentDateTime,
      );
      expect(fixture.request.temporalContext).toEqual(temporalContext);
    }
  },
);

test("legacy result projection derives source-only scope without changing exact receipts", async () => {
  const { view, checkpoint } = await mixedWorkerFixture();
  const original = JSON.parse(buildRequestToolResultsMessage(view).content);
  const legacyCheckpoint = {
    ...checkpoint,
    sourceDigests: original.results.map((result: { executionId: string }) => ({
      sourceRef: result.executionId,
      sourceFingerprint: hash(JSON.stringify(result)),
      digest: "Observed target evidence.",
    })),
  };
  const before = JSON.stringify(legacyCheckpoint);
  const projected = JSON.parse(
    buildCompactedRequestToolResultsMessage(view, legacyCheckpoint).content,
  );
  expect(original).not.toHaveProperty("semanticCheckpoint");
  expect(projected.semanticCheckpoint.evidenceScope).toEqual(
    SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
  );
  expect(projected.results).toEqual([]);
  expect(projected.semanticCheckpoint.continuation).toEqual(
    legacyCheckpoint.continuation,
  );
  expect(
    projected.semanticCheckpoint.coveredResults.map(
      (result: { acceptedAction: unknown }) => result.acceptedAction,
    ),
  ).toEqual(
    original.results.map(
      (result: { acceptedAction: unknown }) => result.acceptedAction,
    ),
  );
  expect(JSON.stringify(legacyCheckpoint)).toBe(before);
});

test("bound SUPER checkpoint projection adds passive scope after canonical source validation", async () => {
  const { view, head, store, checkpoint } = await mixedWorkerFixture();
  const integrity = {
    requestId: head.state.requestId,
    prompt: "Inspect the target.",
    head,
    store,
  };
  const before = JSON.stringify(captureRequestContextCompaction(store));
  const projected = JSON.parse(
    buildCompactedRequestToolResultsMessage(view, checkpoint, integrity)
      .content,
  );
  expect(projected.semanticCheckpoint.evidenceScope).toEqual(
    SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
  );
  expect(projected.semanticCheckpoint.coveredSources).toEqual(
    checkpoint.sourceDigests,
  );
  expect(projected.semanticCheckpoint.continuation).toEqual(
    projectSuperContinuation(checkpoint.continuation),
  );
  expect(
    projected.semanticCheckpoint.coveredResults.map(
      (result: { executionId: string }) => result.executionId,
    ),
  ).toEqual(view.results.map((result) => result.executionId));
  expect(JSON.stringify(captureRequestContextCompaction(store))).toBe(before);
  expect(() =>
    buildCompactedRequestToolResultsMessage(
      view,
      {
        ...checkpoint,
        sourceDigests: checkpoint.sourceDigests.map((source) => ({
          ...source,
          sourceFingerprint: hash("tampered"),
        })),
      },
      integrity,
    ),
  ).toThrow();
});

test("restored dependency checkpoints derive scope only for permitted consumers and retain v2 storage", async () => {
  const {
    ledger,
    call: worker,
    store,
    checkpoint,
  } = await mixedWorkerFixture();
  const snapshot = JSON.parse(
    JSON.stringify(captureRequestContextCompaction(store)),
  );
  const restored = restoreRequestContextCompaction(snapshot);
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: worker.callId,
    outcome: "completed",
    summary: "Target evidence was read.",
  });
  const resultRef = ledger.current().state.results.at(-1)!.resultRef;
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: "Inspect the target.",
    dependencyResultRefs: [resultRef],
  });
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const context = {
    requestId: head.state.requestId,
    prompt: "Inspect the target.",
    head,
    call,
    store: restored,
  };
  for (const consumer of checkpoint.allowedConsumers) {
    const projected = projectSemanticCompactionDependencyResults({
      ...context,
      consumer,
    });
    expect(projected[0]?.semanticCheckpoints).toEqual([
      { ...checkpoint, evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE },
    ]);
    expect(projected[0]?.semanticCheckpoints?.[0]).not.toBe(
      restored.get(checkpoint.scopeId),
    );
  }
  for (const consumer of [
    "supervisor.decision",
    "planner.decision",
    "execution.decision",
  ] as const) {
    expect(
      projectSemanticCompactionDependencyResults({ ...context, consumer })[0],
    ).not.toHaveProperty("semanticCheckpoints");
  }
  expect(JSON.stringify(captureRequestContextCompaction(restored))).toBe(
    JSON.stringify(snapshot),
  );
  expect(restored.get(checkpoint.scopeId)).not.toHaveProperty("evidenceScope");
  expect(() =>
    projectSemanticCompactionDependencyResults({
      ...context,
      prompt: "Another request.",
      consumer: "reviewer.decision",
    }),
  ).toThrow();
});
