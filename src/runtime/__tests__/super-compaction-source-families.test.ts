import { expect, test } from "vitest";
import {
  mixedWorkerFixture,
  commit,
} from "./support/super-mixed-compaction-fixture.js";
import { projectRoleChildReturnContext } from "../orchestration/role-calls/index.js";
import { buildPlannerChildContinuationMessages } from "../steps/planner-decision/resume.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";
import { projectReviewerModelContext } from "../steps/reviewer-decision/model-context.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  assertSuperCompactionSourceIntegrity,
  assertSuperCompactionCheckpointIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import type { ChatMessage } from "../../model-gateway/types.js";

const prompt = "Inspect the target.";
function source(sourceRef: string, message: ChatMessage) {
  const content = JSON.stringify(message);
  return { sourceRef, content, sourceFingerprint: hash(content) };
}

test("historical supervision remains valid after a successful mutation clears current warning state", async () => {
  const { ledger, call, store, checkpoint } = await mixedWorkerFixture();
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "files.write",
    declaredEffect: "mutation",
    intent: "Update target.",
    controlsJson: "{}",
    actionFingerprint: hash("mutation"),
  });
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: ledger.current().state.capabilityExecutions.at(-1)!
      .executionId,
    outcome: "succeeded",
    observedEffect: "mutation",
    summary: "Updated target.",
    outcomeFingerprint: "succeeded",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { updated: true },
    },
  });
  expect(ledger.current().state.operationSupervision.entries).toEqual([]);
  expect(() =>
    assertSuperCompactionCheckpointIntegrity({
      requestId: ledger.current().state.requestId,
      prompt,
      head: ledger.current(),
      store,
      checkpoint,
    }),
  ).not.toThrow();
});

test("historical child result keeps canonical objective, dependency and work receipt across later returns", async () => {
  const { ledger, call, store } = await mixedWorkerFixture(true);
  const returned = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "runtime",
      type: "return_child",
      callerCallId: call.parentCallId!,
      childCallId: call.callId,
      outcome: "completed",
      summary: "Read target.",
    },
  });
  const resume = projectRoleChildReturnContext(ledger, returned);
  const planner = ledger
    .current()
    .state.calls.find((candidate) => candidate.callId === call.parentCallId)!;
  const message = buildPlannerChildContinuationMessages({
    resume,
    currentCallId: planner.callId,
    currentInvocationAttempt: planner.activationCount,
  }).find((message) => message.role === "user")!;
  const stored = source(`child-result:${resume.returnedResultRef}`, message);
  store.registerSources([stored]);
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: planner.callId,
    outcome: "completed",
    summary: "Inspection finished.",
  });
  const input = {
    requestId: ledger.current().state.requestId,
    prompt,
    head: ledger.current(),
    store,
  };
  expect(() => assertSuperCompactionSourceIntegrity(input)).not.toThrow();
  const changed = JSON.parse(message.content);
  changed.summary = "Invented result";
  const changedStore = restoreRequestContextCompaction({
    kind: "request_context_compaction_v1",
    sources: [
      source(stored.sourceRef, {
        role: "user",
        content: JSON.stringify(changed),
      }),
    ],
    checkpoints: [],
  });
  expect(() =>
    assertSuperCompactionSourceIntegrity({ ...input, store: changedStore }),
  ).toThrow("context_compaction_child_evidence_changed");
});

test("v1.2 preserves bounded historical Reviewer bodies and content-hash refs through snapshot", async () => {
  const { ledger, call, store, checkpoint } = await mixedWorkerFixture(
    false,
    "Historical bounded evidence ".repeat(900),
  );
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: call.callId,
    outcome: "completed",
    summary: "Read target.",
  });
  const resultRef = ledger.current().state.results.at(-1)!.resultRef;
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: prompt,
    dependencyResultRefs: [resultRef],
  });
  const head = ledger.current();
  const reviewer = head.state.calls.at(-1)!;
  const review = projectReviewerReviewSnapshot({
    requestId: head.state.requestId,
    requestObjective: prompt,
    ledger,
    call: reviewer,
    referenceDataBudget: { maxTokens: 200 },
    trace: false,
  });
  const message = projectReviewerModelContext(review, reviewer)
    .referenceMessages[0]!;
  expect(message.content).toContain("runtime projection omitted");
  const [headerText, ...body] = message.content.split("\n");
  const header = JSON.parse(headerText!);
  const original = source(`reviewer-evidence:${header.evidenceRef}`, message);
  delete header.evidenceRef;
  const historical = {
    role: "user" as const,
    content: [JSON.stringify(header), ...body].join("\n"),
  };
  const fallback = source(
    `reviewer-evidence:${hash(historical.content).slice(7)}`,
    historical,
  );
  store.registerSources([original, fallback]);
  const reviewerCheckpoint = {
    ...checkpoint,
    callId: reviewer.callId,
    roleId: "reviewer",
    scopeId: `role:reviewer:${reviewer.callId}:continuation`,
    sourceRevision: head.revision,
    objectiveFingerprint: hash(reviewer.objective!),
    allowedConsumers: ["reviewer.decision"] as const,
    sourceDigests: [original, fallback].map(
      ({ sourceRef, sourceFingerprint }) => ({
        sourceRef,
        sourceFingerprint,
        digest: "Bounded historical evidence.",
      }),
    ),
  };
  store.commit(reviewerCheckpoint);
  const snapshot = captureRequestContextCompaction(store);
  const restored = restoreRequestContextCompaction(
    JSON.parse(JSON.stringify(snapshot)),
  );
  const input = {
    requestId: head.state.requestId,
    prompt,
    head,
    store: restored,
  };
  expect(() => assertSuperCompactionSourceIntegrity(input)).not.toThrow();
  expect(() =>
    assertSuperCompactionCheckpointIntegrity({
      ...input,
      checkpoint: reviewerCheckpoint,
    }),
  ).not.toThrow();
  expect(
    restored.materializeSource(original.sourceRef, original.sourceFingerprint)
      ?.content,
  ).toBe(original.content);
});
