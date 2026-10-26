import { workerEvidenceReply } from "./support/worker-evidence-script.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  projectRoleChildReturnContext,
  createRoleCallReviewerVerdictReceipt,
} from "../orchestration/role-calls/index.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import {
  assertSuperCompactionCheckpointIntegrity,
  assertSuperCompactionSourceIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import { projectSemanticCompactionDependencyResults } from "../context/semantic-compaction/dependency-results.js";
import { buildPlannerChildContinuationMessages } from "../steps/planner-decision/resume.js";
import { buildSupervisorContinuationMessages } from "../steps/supervisor-decision/resume.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

import {
  mixedWorkerFixture,
  commit,
} from "./support/super-mixed-compaction-fixture.js";

test("B1: mixed supervision and execution checkpoint survives Worker result handoff", async () => {
  const { ledger, head, call, view, store, checkpoint } =
    await mixedWorkerFixture();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => input.modelStep === "worker.evidence"
    ? workerEvidenceReply(input, false, "Target evidence was read.")
    : { text: "Target evidence was read.", meta: {} });
  const request = createTestRequestExecutionScope({
    requestId: head.state.requestId,
    sessionId: "mixed-session",
    prompt: "Inspect the target.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 2048,
        safetyReserveTokens: 512,
        attachmentReserveTokens: 0,
      },
      steps: {
        "worker.evidence": { timeoutMs: 20000 },
        "worker.decision": { timeoutMs: 20000 },
        "worker.result": { timeoutMs: 20000 },
        "context.compact": { timeoutMs: 20000 },
      },
    } as RequestRunnerConfig,
    modelPolicy: {
      providers: { test: { type: "ollama" } },
      profiles: {
        test: { provider: "test", model: "test", contextWindowTokens: 128000 },
      },
      defaults: {
        profileId: "test",
        steps: {
          "worker.evidence": "test",
          "worker.decision": "test",
          "worker.result": "test",
          "context.compact": "test",
        },
      },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    contextCompactionStore: store,
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  const decision = await runWorkerDecision(request, {
    call,
    requestToolResults: view,
    capabilitySource: {
      ledger,
      head,
      binding: Object.freeze({
        requestId: head.state.requestId,
        ledger,
        callId: call.callId,
        invocationAttempt: call.activationCount,
        capabilities: Object.freeze([]),
      }),
    },
  });
  expect(decision).toEqual({
    action: "return_result",
    result: "Target evidence was read.",
  });
  expect(store.get(checkpoint.scopeId)?.sourceDigests).toEqual(
    checkpoint.sourceDigests,
  );
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "worker.evidence",
    "worker.result",
  ]);
});

test("H1: complete role chain preserves mixed evidence only for permitted consumers", async () => {
  const {
    ledger,
    call: worker,
    checkpoint,
    store,
  } = await mixedWorkerFixture(true);
  const returnedWorker = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "runtime",
      type: "return_child",
      callerCallId: worker.parentCallId!,
      childCallId: worker.callId,
      outcome: "completed",
      summary: "Target evidence was read.",
    },
  });
  expect(returnedWorker.ok).toBe(true);
  const resume = projectRoleChildReturnContext(ledger, returnedWorker);
  const planner = ledger
    .current()
    .state.calls.find((call) => call.callId === worker.parentCallId)!;
  const plannerMessages = buildPlannerChildContinuationMessages({
    resume,
    currentCallId: planner.callId,
    currentInvocationAttempt: planner.activationCount,
  });
  expect(JSON.stringify(plannerMessages)).toContain(resume.returnedResultRef);
  expect(JSON.stringify(plannerMessages)).not.toContain("semanticCheckpoints");
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: planner.callId,
    outcome: "completed",
    summary: "Target inspection is complete.",
  });
  const plannerResult = ledger.current().state.results.at(-1)!;
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: "Inspect the target.",
    dependencyResultRefs: [plannerResult.resultRef],
  });
  const head = ledger.current();
  const reviewer = head.state.calls.at(-1)!;
  assertSuperCompactionCheckpointIntegrity({
    requestId: head.state.requestId,
    prompt: "Inspect the target.",
    head,
    store,
    checkpoint,
  });
  const dependencies = projectSemanticCompactionDependencyResults({
    requestId: head.state.requestId,
    prompt: "Inspect the target.",
    head,
    call: reviewer,
    consumer: "reviewer.decision",
    store,
  });
  expect(dependencies[0]?.semanticCheckpoints?.[0]?.sourceDigests).toEqual(
    checkpoint.sourceDigests,
  );
  const returnedReview = await ledger.apply({
    expectedHead: head,
    command: {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: reviewer.callId,
      outcome: "completed",
      summary: "The bounded review passed.",
      receipt: createRoleCallReviewerVerdictReceipt({
        reviewerCallId: reviewer.callId,
        callerCallId: "call-1",
        reviewScopeId: `review:${reviewer.callId}:r${head.revision}`,
        sourceRevision: head.revision,
        verdict: "pass",
        gaps: [],
      }),
    },
  });
  expect(returnedReview.ok).toBe(true);
  const rootResume = projectRoleChildReturnContext(ledger, returnedReview);
  const root = ledger.current().state.calls[0]!;
  const rootMessages = buildSupervisorContinuationMessages({
    resume: rootResume,
    currentCallId: root.callId,
    currentInvocationAttempt: root.activationCount,
  });
  expect(JSON.stringify(rootMessages)).toContain(plannerResult.resultRef);
  expect(JSON.stringify(rootMessages)).toContain("reviewer_verdict_v1");
  expect(JSON.stringify(rootMessages)).not.toContain("semanticCheckpoints");
  expect(store.get(checkpoint.scopeId)?.sourceDigests).toEqual(
    checkpoint.sourceDigests,
  );
  assertSuperCompactionSourceIntegrity({
    requestId: head.state.requestId,
    prompt: "Inspect the target.",
    head: ledger.current(),
    store,
  });
});

test("P1/P3: healthy mixed sources survive snapshot with and without a committed checkpoint", async () => {
  const { head, store, sources, checkpoint } = await mixedWorkerFixture();
  for (const includeCheckpoint of [false, true]) {
    const original = createRequestContextCompactionStore();
    original.registerSources(sources);
    if (includeCheckpoint) original.commit(checkpoint);
    const snapshot = JSON.parse(
      JSON.stringify(captureRequestContextCompaction(original)),
    );
    expect(snapshot).not.toHaveProperty("invalidatedScopes");
    const restored = restoreRequestContextCompaction(snapshot);
    assertSuperCompactionSourceIntegrity({
      requestId: head.state.requestId,
      prompt: "Inspect the target.",
      head,
      store: restored,
    });
    if (includeCheckpoint)
      assertSuperCompactionCheckpointIntegrity({
        requestId: head.state.requestId,
        prompt: "Inspect the target.",
        head,
        store: restored,
        checkpoint,
      });
    expect(restored.snapshot?.()).toEqual(original.snapshot?.());
  }
  expect(store.get(checkpoint.scopeId)).toEqual(checkpoint);
});
