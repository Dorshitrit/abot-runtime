import { beforeEach, describe, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  traceDebug: vi.fn(),
}));
vi.mock("../observability/debug-logger.js", () => ({
  traceDebug: mocks.traceDebug,
}));
import { projectOllamaFormat } from "../../model-gateway/structured-output.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createSemanticCompactionSha256Fingerprint,
} from "../context/semantic-compaction/index.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
} from "../orchestration/role-calls/index.js";
import {
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  workerCapabilityContextCompactionScopeId,
} from "../orchestration/worker-capabilities/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import {
  createTestRequestExecutionScope,
  deriveTestRequestExecutionScope,
} from "./support/request-execution-scope.js";
import {
  GENERIC_REVIEWER_EXECUTOR,
  REVIEWER_DECISION_MODEL_STEP,
  REVIEWER_DECISION_RESULT_MAX_LENGTH,
  REVIEWER_DECISION_SUMMARY_MAX_LENGTH,
  REVIEWER_GAP_SUMMARY_MAX_LENGTH,
  REVIEWER_ITEM_SUMMARY_MAX_LENGTH,
  REVIEWER_MAX_EVIDENCE,
  assessReviewerDecisionInputBudget,
  buildReviewerDecisionInput,
  createReviewerDecisionFormat,
  normalizeReviewerReviewSnapshot,
  parseReviewerDecisionOutput,
  projectReviewerDecisionCallIdentity,
  projectReviewerReviewSnapshot,
  resolveReviewerDecisionContextBudget,
  type ReviewerDecisionDiagnosticContext,
  type ReviewerReviewSnapshot,
  type ReviewerReviewSnapshotValidationError,
} from "../steps/reviewer-decision/index.js";
import {
  estimateReferenceDataTokens,
  projectReviewerFinalEvidence,
  type ReviewerEvidenceCandidate,
  type ReviewerReferenceDataBudget,
} from "../steps/reviewer-decision/final-evidence.js";
const OBJECTIVE_SECRET = "REVIEWER_OBJECTIVE_SECRET_MUST_NOT_REACH_LOGS";
const FACT_SECRET = "REVIEWER_FACT_SECRET_MUST_NOT_REACH_LOGS";
const EVIDENCE_SECRET = "REVIEWER_EVIDENCE_SECRET_MUST_NOT_REACH_LOGS";
const EVIDENCE_REFERENCE_DATA_SECRET =
  "REVIEWER_REFERENCE_DATA_SECRET_MUST_NOT_REACH_LOGS";
const GAP_SECRET = "REVIEWER_GAP_SECRET_MUST_NOT_REACH_LOGS";
const REQUEST_SOURCE_PROMPT =
  "Verify completion of EXACT_REVIEW_LITERAL for the requested artifact.";

function testExactCapabilityResult(
  input: Readonly<{
    outcome: "succeeded" | "failed";
    observedEffect: "none" | "observation" | "mutation" | "indeterminate";
    summary: string;
  }>,
) {
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: input.outcome === "succeeded",
    payload: Object.freeze({ ...input }),
  });
}
const reviewerReferenceDataBudget: ReviewerReferenceDataBudget = Object.freeze({
  maxTokens: 100_000,
  tokenEstimation: { asciiCharactersPerToken: 4 },
});
function encodeReviewerDecision(
  decision: unknown,
  snapshot: ReviewerReviewSnapshot = reviewSnapshot,
): string {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return JSON.stringify({ decision });
  }
  const record = decision as Record<string, unknown>;
  const reportsGaps = record.action === "report_gaps";
  const audit = {
    evidenceAssessments: snapshot.evidence.map(({ evidenceRef }) => ({
      evidenceRef,
      status: reportsGaps ? "does_not_establish" : "supports",
      finding: reportsGaps
        ? "This evidence does not establish the missing requirement."
        : "This evidence supports the reviewed completion target.",
    })),
    completionAssessment: {
      status: reportsGaps ? "gap" : "satisfied",
      evidenceRefs: snapshot.evidence
        .slice(0, reportsGaps ? 0 : Math.min(2, snapshot.evidence.length))
        .map(({ evidenceRef }) => evidenceRef),
      finding: reportsGaps
        ? "The supplied evidence leaves a completion gap."
        : "The supplied evidence establishes the completion target and its integration edges.",
    },
  };
  return JSON.stringify({
    decision: {
      ...record,
      audit: record.audit ?? audit,
    },
  });
}

function reviewerTargetCandidate(
  executionId: string,
  observedEffect: ReviewerEvidenceCandidate["observedEffect"],
  options: Readonly<{
    outcome?: ReviewerEvidenceCandidate["outcome"];
    referenceData?: string;
  }> = {},
): ReviewerEvidenceCandidate {
  return {
    executionId,
    outcome: options.outcome ?? "succeeded",
    observedEffect,
    summary: executionId,
    ...(options.referenceData ? { referenceData: options.referenceData } : {}),
    references: [{ kind: "tool_target", target: "project/index.html" }],
    subjectRef: "call:call-3",
  };
}

const reviewerCall: RoleCallFrame = Object.freeze({
  callId: "call-4",
  parentCallId: "call-2",
  roleId: "reviewer",
  depth: 2,
  objective: "Create both requested landing-page artifacts.",
  dependencyResultRefs: [],
  status: "active",
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});

const reviewSnapshot: ReviewerReviewSnapshot = {
  reviewScopeId: "review-scope-4",
  reviewerCallId: "call-4",
  callerCallId: "call-2",
  sourceRevision: 12,
  projectionComplete: true,
  freshness: "current",
  allowedGapKinds: [
    "incomplete_outcome",
    "missing_evidence",
    "missing_artifact",
    "state_mismatch",
    "contradictory_fact",
    "indeterminate_fact",
  ],
  subjects: [
    {
      subjectRef: "requirement:landing-page",
      kind: "caller_objective",
      summary: "Create both requested landing-page artifacts.",
    },
    {
      subjectRef: "artifact:index",
      kind: "artifact",
      summary: "The requested HTML artifact.",
    },
  ],
  facts: [
    {
      factRef: "fact:index-current",
      kind: "artifact_state",
      status: "satisfied",
      subjectRefs: ["artifact:index"],
      evidenceRefs: ["evidence:index-write"],
      summary: `The HTML artifact exists. ${FACT_SECRET}`,
    },
  ],
  evidence: [
    {
      evidenceRef: "evidence:index-write",
      kind: "capability_result",
      outcome: "succeeded",
      effect: "mutation",
      subjectRefs: ["artifact:index"],
      summary: `The logical HTML target was established. ${EVIDENCE_SECRET}`,
      references: [{ kind: "tool_target", target: "project/index.html" }],
      referenceData: EVIDENCE_REFERENCE_DATA_SECRET,
    },
  ],
};

const diagnostic: ReviewerDecisionDiagnosticContext = Object.freeze({
  requestId: "request-reviewer-contract",
  modelStep: REVIEWER_DECISION_MODEL_STEP,
  callId: "call-4",
  parentCallId: "call-2",
  depth: 2,
  invocationAttempt: 1,
});

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-default",
      steps: {
        [REVIEWER_DECISION_MODEL_STEP]: "reviewer.decision",
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    [REVIEWER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
  },
};

const modelPolicy = {
  providers: { local: { type: "ollama" as const } },
  profiles: {
    "runtime-default": {
      provider: "local",
      model: "runtime-default:latest",
      contextWindowTokens: 8_000,
      supportsThinking: true,
      calibration: {
        "reviewer.decision": {},
      },
    },
  },
  defaults: {
    profileId: "runtime-default",
    steps: {
      [REVIEWER_DECISION_MODEL_STEP]: "reviewer.decision",
    },
  },
};

function createReviewerRequest(
  invoke: ModelGatewayClient["invoke"],
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "request-reviewer-execution",
    sessionId: "session-reviewer-execution",
    prompt: REQUEST_SOURCE_PROMPT,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    agentMode: "reasoning",
    modelPolicy,
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}

type ReviewerAuditCapsule = Readonly<{
  kind: "runtime_reviewer_audit_v4";
  dependencySubjects: readonly Readonly<{
    producerCallId: string;
    roleId: string;
    resultRef: string;
    presenceEffect: string;
    [key: string]: unknown;
  }>[];
  candidateSupportPolicy: Readonly<{
    authority: "runtime_projection";
    sourceClaimsAndEffectsMaySupportTarget: true;
    edgeAloneEstablishesCompletion: false;
    distinctSourceAndTargetRefsExpected: true;
  }>;
  candidateSupportEdges: readonly Readonly<{
    sourceSubjectRef: string;
    targetSubjectRef: string;
    relation: "candidate_support";
  }>[];
  completionTarget: Readonly<{
    authority: string;
    subjectRef: string;
    text: string;
  }>;
  claims: readonly Readonly<{
    claimRef: string;
    subjectRefs: readonly string[];
    [key: string]: unknown;
  }>[];
  effects: readonly Readonly<{
    evidenceRef: string;
    subjectRefs: readonly string[];
    [key: string]: unknown;
  }>[];
}>;

function readReviewerAuditCapsule(
  messages: readonly Readonly<{ content: string }>[],
): ReviewerAuditCapsule {
  for (const message of messages) {
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (parsed.kind === "runtime_reviewer_audit_v4") {
        return parsed as unknown as ReviewerAuditCapsule;
      }
    } catch {
      // Evidence appendices contain a JSON header plus bounded raw content.
    }
  }
  throw new Error("reviewer audit capsule missing");
}

async function createReviewerExecutionLedger(
  options: Readonly<{
    callerObjective?: string;
    childObjective?: string;
    childResultSummary?: string;
    referenceData?: string;
  }> = {},
): Promise<{
  ledger: RoleCallLedger;
  call: RoleCallFrame;
}> {
  const callerObjective =
    options.callerObjective ??
    "Create and verify the requested bounded artifact.";
  const childObjective =
    options.childObjective ??
    "Create the requested artifact and report the outcome.";
  const ledger = createRoleCallLedger({
    requestId: "request-reviewer-execution",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: callerObjective,
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective: childObjective,
    plannerPlan: {
      mode: "declare",
      plan: {
        summary: "Create the requested artifact, then review completion.",
        items: [
          {
            title: "Create artifact",
            objective: childObjective,
          },
          {
            title: "Review completion",
            objective: callerObjective,
          },
        ],
      },
      selectedItemIndexes: [0],
    },
  });
  const worker = ledger
    .current()
    .state.calls.find(({ callId }) => callId === "call-3")!;
  const begun = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: worker.callId,
      invocationAttempt: worker.activationCount,
      capabilityId: "write_complete_file",
      declaredEffect: "mutation",
      intent: "Write the complete requested file.",
      controlsJson: "{}",
    },
  });
  if (!begun.ok || begun.effect.type !== "capability_execution_begun") {
    throw new Error("reviewer fixture capability begin failed");
  }
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: worker.callId,
    executionId: begun.effect.executionId,
    outcome: "succeeded",
    observedEffect: "mutation",
    summary: "The requested artifact was created.",
    exactResult: testExactCapabilityResult({
      outcome: "succeeded",
      observedEffect: "mutation",
      summary: "The requested artifact was created.",
    }),
    referenceData: options.referenceData ?? EVIDENCE_REFERENCE_DATA_SECRET,
    references: [{ kind: "tool_target", target: "project/index.html" }],
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-2",
    childCallId: worker.callId,
    outcome: "completed",
    summary:
      options.childResultSummary ??
      "The requested artifact was created and verified.",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "reviewer",
    objective: callerObjective,
    dependencyResultRefs: ledger.current().state.results.slice(-1).map(({ resultRef }) => resultRef),
    plannerPlan: {
      mode: "select",
      itemIds: ["plan-call-2-item-2"],
    },
  });
  const call = ledger
    .current()
    .state.calls.find(({ callId }) => callId === "call-4");
  if (!call) throw new Error("reviewer fixture call missing");
  return { ledger, call };
}

function commitWorkerEvidenceCheckpoint(
  params: Readonly<{
    request: RequestExecutionScope;
    ledger: RoleCallLedger;
    workerCallId: string;
    digest: string;
  }>,
): string {
  const head = params.ledger.current();
  const worker = head.state.calls.find(
    ({ callId }) => callId === params.workerCallId,
  );
  if (!worker?.objective || !params.request.contextCompactionStore) {
    throw new Error("reviewer checkpoint fixture unavailable");
  }
  const view = projectRequestToolResults({
    ledger: params.ledger,
    head,
    modelStep: REVIEWER_DECISION_MODEL_STEP,
    callId: worker.callId,
  });
  const message = JSON.parse(buildRequestToolResultsMessage(view).content) as {
    results: readonly Record<string, unknown>[];
  };
  const result = message.results[0];
  const executionId = result?.executionId;
  if (typeof executionId !== "string") {
    throw new Error("reviewer checkpoint fixture source missing");
  }
  const content = JSON.stringify(result);
  const sourceFingerprint = createSemanticCompactionSha256Fingerprint(content);
  params.request.contextCompactionStore.registerSources([
    Object.freeze({ sourceRef: executionId, sourceFingerprint, content }),
  ]);
  params.request.contextCompactionStore.commit(
    Object.freeze({
      kind: "runtime_semantic_compaction_checkpoint_v2" as const,
      scopeId: workerCapabilityContextCompactionScopeId(worker.callId),
      requestId: params.request.requestId,
      currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
        params.request.prompt,
      ),
      roleId: worker.roleId,
      callId: worker.callId,
      objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
        worker.objective,
      ),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
      sourceRevision: view.sourceRevision,
      sourceDigests: Object.freeze([
        Object.freeze({
          sourceRef: executionId,
          sourceFingerprint,
          digest: params.digest,
        }),
      ]),
      continuation: Object.freeze({
        completed: Object.freeze(["The Worker evidence was collected."]),
        currentState: "The Worker completed its bounded objective.",
        findings: Object.freeze([params.digest]),
        evidenceRefs: Object.freeze([executionId]),
        artifacts: Object.freeze([]),
        decisions: Object.freeze([]),
        failedApproaches: Object.freeze([]),
        openWork: Object.freeze([]),
        blockers: Object.freeze([]),
        nextStep: "Return the completed result to the caller.",
      }),
    }),
  );
  return executionId;
}

async function createRootReviewerObservationOnlyLedger(): Promise<{
  ledger: RoleCallLedger;
  call: RoleCallFrame;
}> {
  const ledger = createRoleCallLedger({
    requestId: "request-reviewer-root",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective:
      "Compare current research with news.txt and add missing information.",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective:
      "Inspect the current source material and complete the requested update.",
    plannerPlan: {
      mode: "declare",
      plan: {
        summary:
          "Inspect the source material and complete the requested update.",
        items: [
          {
            title: "Complete the requested update",
            objective:
              "Inspect the current source material and complete the requested update.",
          },
        ],
      },
      selectedItemIndexes: [0],
    },
  });
  const worker = ledger
    .current()
    .state.calls.find(({ callId }) => callId === "call-3")!;
  const begun = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: worker.callId,
      invocationAttempt: worker.activationCount,
      capabilityId: "inspect_target",
      declaredEffect: "observation",
      intent: "Inspect the requested target.",
      controlsJson: "{}",
    },
  });
  if (!begun.ok || begun.effect.type !== "capability_execution_begun") {
    throw new Error("reviewer root fixture capability begin failed");
  }
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: worker.callId,
    executionId: begun.effect.executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "news.txt was inspected and still contains no GPT material.",
    exactResult: testExactCapabilityResult({
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "news.txt was inspected and still contains no GPT material.",
    }),
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-2",
    childCallId: worker.callId,
    outcome: "completed",
    summary: "The missing GPT material was appended to news.txt.",
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-2",
    outcome: "completed",
    summary: "The missing GPT material was appended to news.txt.",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective:
      "Compare current GPT research with news.txt and add missing information to the file.",
    dependencyResultRefs: ledger.current().state.results.slice(-1).map(({ resultRef }) => resultRef),
  });
  const call = ledger
    .current()
    .state.calls.find(({ callId }) => callId === "call-4");
  if (!call) throw new Error("reviewer root fixture call missing");
  return { ledger, call };
}

async function createRootReviewerAfterPriorReviewLedger(): Promise<{
  ledger: RoleCallLedger;
  call: RoleCallFrame;
}> {
  const ledger = createRoleCallLedger({
    requestId: "request-reviewer-repeated-cycle",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: "Prepare the first bounded contribution for the root request.",
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-2",
    outcome: "completed",
    summary: "The Planner returned the first bounded contribution.",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: "Complete the root request from the Planner contribution and the later Worker repair.",
    dependencyResultRefs: ledger.current().state.results.map(({ resultRef }) => resultRef),
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-3",
    outcome: "completed",
    summary: JSON.stringify({
      action: "report_gaps",
      summary: "One repair remains.",
    }),
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Complete the bounded repair identified after review.",
  });
  await commitReviewerLedger(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-4",
    outcome: "completed",
    summary: "The Worker returned the bounded repair.",
  });
  await commitReviewerLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: "Complete the root request from the Planner contribution and the later Worker repair.",
    dependencyResultRefs: ledger.current().state.results.map(({ resultRef }) => resultRef),
  });
  const call = ledger
    .current()
    .state.calls.find(({ callId }) => callId === "call-5");
  if (!call) throw new Error("repeated Reviewer fixture call missing");
  return { ledger, call };
}

async function commitReviewerLedger(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
): Promise<void> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) {
    throw new Error(`reviewer fixture commit failed:${result.code}`);
  }
}

describe("generic Reviewer decision boundary", () => {
  beforeEach(() => {
    mocks.traceDebug.mockReset();
  });

  test("publishes both verdicts from one strict scope-bound schema", () => {
    const format = createReviewerDecisionFormat(reviewSnapshot);
    expect(format).toMatchObject({
      type: "json_schema",
      name: "reviewer_decision",
      strict: true,
      schema: {
        type: "object",
        properties: {
          decision: {
            anyOf: [
              {
                properties: {
                  action: { enum: ["pass"] },
                  reviewScopeId: { enum: ["review-scope-4"] },
                  summary: { maxLength: REVIEWER_DECISION_SUMMARY_MAX_LENGTH },
                  gaps: { minItems: 0, maxItems: 0 },
                },
                additionalProperties: false,
              },
              {
                properties: {
                  action: { enum: ["report_gaps"] },
                  reviewScopeId: { enum: ["review-scope-4"] },
                  summary: { maxLength: REVIEWER_DECISION_SUMMARY_MAX_LENGTH },
                  gaps: {
                    minItems: 1,
                    maxItems: 5,
                    items: {
                      properties: {
                        kind: {
                          enum: reviewSnapshot.allowedGapKinds,
                        },
                        subjectRefs: {
                          maxItems: 1,
                          items: {
                            enum: [
                              "requirement:landing-page",
                              "artifact:index",
                            ],
                          },
                        },
                        factRefs: {
                          maxItems: 1,
                          items: { enum: ["fact:index-current"] },
                        },
                        evidenceRefs: {
                          maxItems: 1,
                          items: { enum: ["evidence:index-write"] },
                        },
                        summary: {
                          maxLength: REVIEWER_GAP_SUMMARY_MAX_LENGTH,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["decision"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(format.schema)).not.toContain('"pattern"');
    expect(JSON.stringify(format.schema)).not.toContain('"uniqueItems"');
    expect(projectOllamaFormat(format).diagnostics).toHaveLength(7);
  });

  test.each([
    ["an incomplete projection", { projectionComplete: false }],
    ["unavailable freshness", { freshness: "unavailable" as const }],
  ])("removes and defensively rejects pass for %s", (_label, override) => {
    const snapshot: ReviewerReviewSnapshot = {
      ...reviewSnapshot,
      ...override,
    };
    const format = createReviewerDecisionFormat(snapshot);
    const decisionSchema = (
      format.schema as {
        properties: {
          decision: {
            anyOf?: unknown;
            properties: { action: { enum: readonly string[] } };
          };
        };
      }
    ).properties.decision;

    expect(decisionSchema.anyOf).toBeUndefined();
    expect(decisionSchema.properties.action.enum).toEqual(["report_gaps"]);
    expect(projectOllamaFormat(format).diagnostics).toHaveLength(4);
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "pass",
          reviewScopeId: snapshot.reviewScopeId,
          summary: "Completion was claimed.",
          gaps: [],
        }),
        { snapshot },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        expect.objectContaining({
          code: "reviewer_pass_evidence_incomplete",
          path: "decision.action",
        }),
      ],
    });
  });

  test("parses and deeply freezes pass and gap verdicts", () => {
    const pass = parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "pass",
        reviewScopeId: "review-scope-4",
        summary: "  All supplied high-level outcomes are established.  ",
        gaps: [],
      }),
      { snapshot: reviewSnapshot },
    );
    const gaps = parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        summary: "One requested artifact is not established.",
        gaps: [
          {
            kind: "missing_artifact",
            subjectRefs: ["requirement:landing-page"],
            factRefs: [],
            evidenceRefs: [],
            summary: "The stylesheet outcome is absent.",
          },
        ],
      }),
      { snapshot: reviewSnapshot },
    );

    expect(pass).toEqual({
      ok: true,
      decision: {
        action: "pass",
        reviewScopeId: "review-scope-4",
        summary: "All supplied high-level outcomes are established.",
        gaps: [],
      },
    });
    expect(gaps).toMatchObject({
      ok: true,
      decision: {
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        gaps: [
          {
            kind: "missing_artifact",
            subjectRefs: ["requirement:landing-page"],
            factRefs: [],
            evidenceRefs: [],
          },
        ],
      },
    });
    if (pass.ok) expect(Object.isFrozen(pass.decision)).toBe(true);
    if (gaps.ok) {
      expect(Object.isFrozen(gaps.decision)).toBe(true);
      expect(Object.isFrozen(gaps.decision.gaps)).toBe(true);
      expect(Object.isFrozen(gaps.decision.gaps[0])).toBe(true);
    }
  });

  test("allows a bounded whole-scope omission without a plan-item reference", () => {
    const parsed = parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        summary: "The reviewed projection omits one requested outcome.",
        gaps: [
          {
            kind: "incomplete_outcome",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary:
              "A separately requested follow-up artifact is absent from the supplied work.",
          },
        ],
      }),
      { snapshot: reviewSnapshot },
    );

    expect(parsed).toMatchObject({
      ok: true,
      decision: {
        action: "report_gaps",
        gaps: [
          {
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
          },
        ],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("planId");
    expect(JSON.stringify(parsed)).not.toContain("planItemId");
  });

  test("accepts a concise natural-language gap beyond the former 160-character cap", () => {
    const gapSummary =
      "A detailed finding report confirming which specific pieces of information are novel additions to the knowledge base derived from the search results relative to the file's current state is missing.";

    expect(gapSummary.length).toBeGreaterThan(160);
    expect(gapSummary.length).toBeLessThanOrEqual(
      REVIEWER_GAP_SUMMARY_MAX_LENGTH,
    );
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "report_gaps",
          reviewScopeId: reviewSnapshot.reviewScopeId,
          summary: "The requested comparison and mutation are not established.",
          gaps: [
            {
              kind: "missing_artifact",
              subjectRefs: ["requirement:landing-page"],
              factRefs: [],
              evidenceRefs: [],
              summary: gapSummary,
            },
          ],
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({ ok: true });
  });

  test("rejects invalid envelopes, scope, cardinality, and references", () => {
    expect(
      parseReviewerDecisionOutput("not-json", {
        snapshot: reviewSnapshot,
      }),
    ).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "reviewer_output_not_json", path: "decision" }],
    });
    expect(
      parseReviewerDecisionOutput(
        JSON.stringify({
          action: "pass",
          reviewScopeId: "review-scope-4",
          summary: "Legacy flat decision.",
          gaps: [],
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "reviewer_output_envelope_invalid", path: "decision" }],
    });
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "pass",
          reviewScopeId: "foreign-scope",
          summary: "Complete.",
          gaps: [],
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        { code: "reviewer_scope_mismatch", path: "decision.reviewScopeId" },
      ],
    });
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "pass",
          reviewScopeId: "review-scope-4",
          summary: "Complete.",
          gaps: [
            {
              kind: "missing_artifact",
              subjectRefs: [],
              factRefs: [],
              evidenceRefs: [],
              summary: "Contradictory gap.",
            },
          ],
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "reviewer_pass_gaps_invalid", path: "decision.gaps" }],
    });
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "report_gaps",
          reviewScopeId: "review-scope-4",
          summary: "Gap.",
          gaps: [],
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "reviewer_gaps_required", path: "decision.gaps" }],
    });
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "report_gaps",
          reviewScopeId: "review-scope-4",
          summary: "Gap.",
          gaps: [
            {
              kind: "missing_artifact",
              subjectRefs: ["unknown:subject"],
              factRefs: ["fact:index-current", "fact:index-current"],
              evidenceRefs: [],
              summary: "Invalid references.",
            },
          ],
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "reviewer_gap_ref_unknown",
          path: "decision.gaps[0].subjectRefs[0]",
        }),
        expect.objectContaining({
          code: "reviewer_gap_refs_invalid",
          path: "decision.gaps[0].factRefs",
        }),
      ]),
    });
  });

  test("bounds oversized descriptive text without rejecting a valid verdict", () => {
    const parsed = parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        summary: "d".repeat(REVIEWER_DECISION_SUMMARY_MAX_LENGTH + 12),
        gaps: [
          {
            kind: "missing_artifact",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary: "g".repeat(REVIEWER_GAP_SUMMARY_MAX_LENGTH + 44),
          },
        ],
      }),
      { snapshot: reviewSnapshot, diagnostic },
    );

    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) throw new Error("expected normalized Reviewer decision");
    expect(parsed.decision.summary).toHaveLength(
      REVIEWER_DECISION_SUMMARY_MAX_LENGTH,
    );
    expect(parsed.decision.summary.endsWith("…")).toBe(true);
    expect(parsed.decision.gaps[0]?.summary).toHaveLength(
      REVIEWER_GAP_SUMMARY_MAX_LENGTH,
    );
    expect(parsed.decision.gaps[0]?.summary.endsWith("…")).toBe(true);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.reviewer",
      "decision.text_normalized",
      expect.objectContaining({
        path: "decision.gaps[0].summary",
        reason: "max_length",
        inputLength: REVIEWER_GAP_SUMMARY_MAX_LENGTH + 44,
        outputLength: REVIEWER_GAP_SUMMARY_MAX_LENGTH,
        maxLength: REVIEWER_GAP_SUMMARY_MAX_LENGTH,
      }),
    );
    expect(mocks.traceDebug).not.toHaveBeenCalledWith(
      "runtime.reviewer",
      "decision.rejected",
      expect.anything(),
    );
  });

  test.each([
    ["control character", "invalid\u0007summary"],
    ["unpaired high surrogate", "invalid\uD800summary"],
    ["unpaired low surrogate", "invalid\uDFFFsummary"],
  ])("post-validates %s in every summary field", (_label, invalidSummary) => {
    const invalidDecisionSummary = parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "pass",
        reviewScopeId: "review-scope-4",
        summary: invalidSummary,
        gaps: [],
      }),
      { snapshot: reviewSnapshot },
    );
    const invalidGapSummary = parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        summary: "One high-level gap remains.",
        gaps: [
          {
            kind: "missing_artifact",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary: invalidSummary,
          },
        ],
      }),
      { snapshot: reviewSnapshot },
    );

    expect(invalidDecisionSummary).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [{ code: "reviewer_summary_invalid", path: "decision.summary" }],
    });
    expect(invalidGapSummary).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "reviewer_gap_summary_invalid",
          path: "decision.gaps[0].summary",
        },
      ],
    });
  });

  test("keeps every maximum schema-shaped verdict within the role-result bound", () => {
    const maximumSnapshot: ReviewerReviewSnapshot = {
      reviewScopeId: "r".repeat(256),
      reviewerCallId: "call-4",
      callerCallId: "call-2",
      sourceRevision: 12,
      projectionComplete: true,
      freshness: "current",
      allowedGapKinds: ["k".repeat(160)],
      subjects: [
        {
          subjectRef: "s".repeat(256),
          kind: "requirement",
          summary: "Maximum subject.",
        },
      ],
      facts: [
        {
          factRef: "f".repeat(256),
          kind: "completion",
          status: "missing",
          subjectRefs: ["s".repeat(256)],
          evidenceRefs: ["e".repeat(256)],
          summary: "Maximum fact.",
        },
      ],
      evidence: [
        {
          evidenceRef: "e".repeat(256),
          kind: "capability_result",
          outcome: "failed",
          effect: "none",
          subjectRefs: ["s".repeat(256)],
          summary: "Maximum evidence.",
        },
      ],
    };
    const parsed = parseReviewerDecisionOutput(
      encodeReviewerDecision(
        {
          action: "report_gaps",
          reviewScopeId: maximumSnapshot.reviewScopeId,
          summary: "\\".repeat(REVIEWER_DECISION_SUMMARY_MAX_LENGTH),
          gaps: Array.from({ length: 5 }, () => ({
            kind: maximumSnapshot.allowedGapKinds[0],
            subjectRefs: [maximumSnapshot.subjects[0]!.subjectRef],
            factRefs: [maximumSnapshot.facts[0]!.factRef],
            evidenceRefs: [maximumSnapshot.evidence[0]!.evidenceRef],
            summary: "\\".repeat(REVIEWER_GAP_SUMMARY_MAX_LENGTH),
          })),
        },
        maximumSnapshot,
      ),
      { snapshot: maximumSnapshot },
    );

    expect(REVIEWER_DECISION_RESULT_MAX_LENGTH).toBe(8_192);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(JSON.stringify(parsed.decision).length).toBeLessThanOrEqual(
        REVIEWER_DECISION_RESULT_MAX_LENGTH,
      );
    }

    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision({
          action: "report_gaps",
          reviewScopeId: "review-scope-4",
          summary: "Too many gaps.",
          gaps: Array.from({ length: 6 }, () => ({
            kind: "missing_artifact",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary: "Gap.",
          })),
        }),
        { snapshot: reviewSnapshot },
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "reviewer_gaps_invalid",
          path: "decision.gaps",
        }),
      ],
    });
  });

  test("validates exact call ownership and returns a detached frozen snapshot", () => {
    const mutable = structuredClone(reviewSnapshot);
    const normalized = normalizeReviewerReviewSnapshot(mutable, reviewerCall);
    (
      mutable as unknown as {
        facts: Array<{ summary: string }>;
      }
    ).facts[0]!.summary = "MUTATED_AFTER_PROJECTION";

    expect(normalized).toEqual(reviewSnapshot);
    expect(normalized.facts[0]!.summary).not.toContain(
      "MUTATED_AFTER_PROJECTION",
    );
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.facts)).toBe(true);
    expect(Object.isFrozen(normalized.facts[0])).toBe(true);

    for (const invalid of [
      { ...reviewSnapshot, callerCallId: "call-foreign" },
      {
        ...reviewSnapshot,
        facts: [
          {
            ...reviewSnapshot.facts[0]!,
            evidenceRefs: ["evidence:foreign"],
          },
        ],
      },
      {
        ...reviewSnapshot,
        allowedGapKinds: ["missing_artifact", "missing_artifact"],
      },
      {
        ...reviewSnapshot,
        subjects: reviewSnapshot.subjects.map((subject) =>
          subject.kind === "caller_objective"
            ? { ...subject, kind: "requirement" }
            : subject,
        ),
      },
      {
        ...reviewSnapshot,
        subjects: [
          ...reviewSnapshot.subjects,
          {
            subjectRef: "requirement:duplicate-authority",
            kind: "caller_objective",
            summary: "A conflicting duplicate completion target.",
          },
        ],
      },
    ]) {
      expect(() =>
        normalizeReviewerReviewSnapshot(invalid, reviewerCall),
      ).toThrow("reviewer_snapshot_invalid");
    }
  });

  test("rejects Reviewer evidence that exceeds its resolved reference-data budget", () => {
    const referenceDataBudget: ReviewerReferenceDataBudget = {
      maxTokens: 100,
      tokenEstimation: { asciiCharactersPerToken: 4 },
    };
    const first = "a".repeat(300);
    const second = "b".repeat(300);
    expect(() =>
      normalizeReviewerReviewSnapshot(
        {
          ...reviewSnapshot,
          evidence: [
            { ...reviewSnapshot.evidence[0]!, referenceData: first },
            {
              ...reviewSnapshot.evidence[0]!,
              evidenceRef: "evidence:secondary-write",
              referenceData: second,
            },
          ],
        },
        reviewerCall,
        referenceDataBudget,
      ),
    ).toThrow("reviewer_snapshot_invalid");
  });

  test("requires one first-activation non-root Reviewer frame", () => {
    expect(projectReviewerDecisionCallIdentity(reviewerCall)).toEqual({
      callId: "call-4",
      parentCallId: "call-2",
      depth: 2,
      invocationAttempt: 1,
    });
    for (const invalid of [
      { ...reviewerCall, roleId: "worker" as const },
      { ...reviewerCall, parentCallId: null, depth: 0 },
      { ...reviewerCall, status: "completed" as const },
      { ...reviewerCall, objective: null },
      { ...reviewerCall, childCallIds: ["call-5"], activationCount: 2 },
      { ...reviewerCall, resultRef: "result-2" },
    ]) {
      expect(() => projectReviewerDecisionCallIdentity(invalid)).toThrow(
        "reviewer_call_frame_invalid",
      );
    }
  });

  test("projects one authority target, subordinate claims, and evidence appendices before the audit capsule", () => {
    const methodologySentinel =
      "REVIEWER_METHODOLOGY_SENTINEL_USE_FINAL_EVIDENCE";
    const configuredRunnerConfig: RequestRunnerConfig = {
      ...runnerConfig,
      steps: {
        [REVIEWER_DECISION_MODEL_STEP]: {
          timeoutMs: 20_000,
          instructionBlocks: [
            {
              ref: "./methodologies/reviewer-evidence.md",
              content: methodologySentinel,
              contentHash: "reviewer-methodology-hash",
            },
          ],
        },
      },
    };
    const input = buildReviewerDecisionInput(
      {
        requestId: "request-reviewer-context",
        prompt: REQUEST_SOURCE_PROMPT,
        runnerConfig: configuredRunnerConfig,
        agentMode: "reasoning",
        modelPolicy,
      },
      {
        call: reviewerCall,
        snapshot: reviewSnapshot,
        referenceDataBudget: reviewerReferenceDataBudget,
      },
    );
    const serializedMessages = JSON.stringify(input.context.messages);
    const parsedMessages = input.context.messages.flatMap((message) => {
      try {
        return [
          JSON.parse(message.content.split("\n", 1)[0]!) as Record<
            string,
            unknown
          >,
        ];
      } catch {
        return [];
      }
    });
    const evidenceAppendixIndex = parsedMessages.findIndex(
      ({ kind }) => kind === "runtime_reviewer_evidence_v1",
    );
    const auditIndex = parsedMessages.findIndex(
      ({ kind }) => kind === "runtime_reviewer_audit_v4",
    );
    const evidenceAppendix = parsedMessages[evidenceAppendixIndex]!;
    const evidenceAppendixMessage = input.context.messages.find(({ content }) =>
      content.includes('"kind":"runtime_reviewer_evidence_v1"'),
    )!;
    const audit = readReviewerAuditCapsule(input.context.messages);

    expect(input.modelStep).toBe(REVIEWER_DECISION_MODEL_STEP);
    expect(input.snapshot).toEqual(reviewSnapshot);
    expect(evidenceAppendix).toMatchObject({
      kind: "runtime_reviewer_evidence_v1",
      authority: "reference_data",
      evidenceRef: "evidence:index-write",
    });
    expect(evidenceAppendixMessage.content).toContain(
      EVIDENCE_REFERENCE_DATA_SECRET,
    );
    expect(evidenceAppendixIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(evidenceAppendixIndex);
    expect(audit.completionTarget).toEqual({
      authority: "caller",
      subjectRef: "requirement:landing-page",
      text: "Create both requested landing-page artifacts.",
    });
    expect(audit.candidateSupportPolicy).toEqual({
      authority: "runtime_projection",
      sourceClaimsAndEffectsMaySupportTarget: true,
      edgeAloneEstablishesCompletion: false,
      distinctSourceAndTargetRefsExpected: true,
    });
    expect(audit.candidateSupportEdges).toEqual([
      {
        sourceSubjectRef: "artifact:index",
        targetSubjectRef: "requirement:landing-page",
        relation: "candidate_support",
      },
    ]);
    expect(audit.claims).toEqual([
      expect.objectContaining({
        claimRef: "fact:index-current",
        status: "satisfied",
        subjectRefs: ["artifact:index"],
        summary: `The HTML artifact exists. ${FACT_SECRET}`,
      }),
    ]);
    expect(audit.claims[0]).not.toHaveProperty("authority");
    expect(audit.effects).toEqual([
      expect.objectContaining({
        evidenceRef: "evidence:index-write",
        subjectRefs: ["artifact:index"],
        referenceDataSupplied: true,
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(EVIDENCE_REFERENCE_DATA_SECRET);
    expect(
      input.context.messages.filter(({ content }) =>
        content.includes(audit.completionTarget.text),
      ),
    ).toHaveLength(1);
    expect(serializedMessages).not.toContain(methodologySentinel);
    expect(serializedMessages).not.toContain(
      "./methodologies/reviewer-evidence.md",
    );
    expect(serializedMessages).not.toContain("reviewer-methodology-hash");
    expect(serializedMessages).not.toContain("runtime_request_source_v1");
    expect(serializedMessages).not.toContain(REQUEST_SOURCE_PROMPT);
    expect(serializedMessages).not.toContain(OBJECTIVE_SECRET);
    expect(serializedMessages).not.toContain("reviewer_objective");
    expect(serializedMessages).toContain(FACT_SECRET);
    expect(serializedMessages).toContain(EVIDENCE_SECRET);
    expect(serializedMessages).not.toContain("runtime_planner_assignment");
    expect(serializedMessages).not.toContain("planItemId");
    expect(serializedMessages).not.toContain("historyMessages");
    expect(serializedMessages).not.toContain("attachments");

    const logs = JSON.stringify(mocks.traceDebug.mock.calls);
    expect(logs).toContain("context.projected");
    expect(logs).not.toContain(OBJECTIVE_SECRET);
    expect(logs).not.toContain(FACT_SECRET);
    expect(logs).not.toContain(EVIDENCE_SECRET);
    expect(logs).not.toContain(EVIDENCE_REFERENCE_DATA_SECRET);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.reviewer",
      "context.projected",
      expect.objectContaining({
        contextWindowTokens: 8_000,
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        formatReserveTokens: expect.any(Number),
        attachmentReserveTokens: 0,
        estimatedInputTokens: expect.any(Number),
        availableInputTokens: expect.any(Number),
        factStatusCounts: {
          satisfied: 1,
          missing: 0,
          mismatched: 0,
          contradictory: 0,
          indeterminate: 0,
          informational: 0,
        },
        configuredInstructionBlockCount: 1,
        configuredInstructionCharacterCount: methodologySentinel.length,
        configuredInstructionRefs: ["./methodologies/reviewer-evidence.md"],
        configuredInstructionContentHashes: ["reviewer-methodology-hash"],
      }),
    );
  });

  test("logs accepted and rejected decisions without summaries or raw output", () => {
    parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        summary: "One high-level gap remains.",
        gaps: [
          {
            kind: "missing_artifact",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary: GAP_SECRET,
          },
        ],
      }),
      { snapshot: reviewSnapshot, diagnostic },
    );
    parseReviewerDecisionOutput(
      encodeReviewerDecision({
        action: "report_gaps",
        reviewScopeId: "review-scope-4",
        summary: "Rejected gap.",
        gaps: [
          {
            kind: "not_allowed",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary: "REJECTED_REVIEWER_SECRET",
          },
        ],
      }),
      { snapshot: reviewSnapshot, diagnostic },
    );

    const logs = JSON.stringify(mocks.traceDebug.mock.calls);
    expect(logs).toContain("output.envelope.accepted");
    expect(logs).toContain("decision.accepted");
    expect(logs).toContain("decision.rejected");
    expect(logs).toContain("reviewer_gap_kind_invalid");
    expect(logs).not.toContain(GAP_SECRET);
    expect(logs).not.toContain("REJECTED_REVIEWER_SECRET");
    expect(logs).not.toContain(FACT_SECRET);
    expect(logs).not.toContain(EVIDENCE_SECRET);
  });

  test("logs snapshot rejection as bounded issue codes and paths", () => {
    try {
      buildReviewerDecisionInput(
        {
          requestId: "request-reviewer-invalid-context",
          prompt: REQUEST_SOURCE_PROMPT,
          runnerConfig,
          agentMode: "reasoning",
          modelPolicy,
        },
        {
          call: reviewerCall,
          snapshot: {
            ...reviewSnapshot,
            callerCallId: "call-foreign",
          },
          referenceDataBudget: reviewerReferenceDataBudget,
        },
      );
      throw new Error("expected reviewer snapshot rejection");
    } catch (error: unknown) {
      expect((error as ReviewerReviewSnapshotValidationError).message).toBe(
        "reviewer_snapshot_invalid",
      );
    }

    const logs = JSON.stringify(mocks.traceDebug.mock.calls);
    expect(logs).toContain("context.rejected");
    expect(logs).toContain("reviewer_snapshot_caller_mismatch");
    expect(logs).not.toContain(OBJECTIVE_SECRET);
    expect(logs).not.toContain(FACT_SECRET);
    expect(logs).not.toContain(EVIDENCE_SECRET);
  });

  test("projects exact completed child facts and descendant capability evidence", async () => {
    const { ledger, call } = await createReviewerExecutionLedger();
    const snapshot = projectReviewerReviewSnapshot({
      requestId: "request-reviewer-execution",
      requestObjective: REQUEST_SOURCE_PROMPT,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const input = buildReviewerDecisionInput(createReviewerRequest(vi.fn()), {
      call,
      snapshot,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const audit = readReviewerAuditCapsule(input.context.messages);

    expect(snapshot).toMatchObject({
      reviewerCallId: call.callId,
      callerCallId: "call-2",
      sourceRevision: ledger.current().revision,
      projectionComplete: true,
      freshness: "current",
    });
    expect(snapshot.subjects.map(({ kind }) => kind)).toEqual([
      "caller_objective",
      "worker_result",
    ]);
    expect(snapshot.facts).toEqual([
      expect.objectContaining({
        kind: "role_result",
        status: "informational",
        subjectRefs: ["call:call-3"],
        evidenceRefs: [],
      }),
    ]);
    expect(snapshot.evidence).toEqual([
      expect.objectContaining({
        evidenceRef: "capability-execution-1",
        outcome: "succeeded",
        effect: "mutation",
        subjectRefs: ["call:call-3"],
        references: [{ kind: "tool_target", target: "project/index.html" }],
        referenceData: EVIDENCE_REFERENCE_DATA_SECRET,
      }),
    ]);
    expect(audit.candidateSupportEdges).toEqual([
      {
        sourceSubjectRef: "call:call-3",
        targetSubjectRef: "call:call-2",
        relation: "candidate_support",
      },
    ]);
    expect(audit.claims).toEqual([]);
    expect(audit.effects[0]?.subjectRefs).toEqual(["call:call-3"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.reviewer",
      "snapshot.projected",
      expect.objectContaining({
        factStatusCounts: {
          satisfied: 0,
          missing: 0,
          mismatched: 0,
          contradictory: 0,
          indeterminate: 0,
          informational: 1,
        },
        callerObjectiveSource: "caller_objective",
        evidenceEffectCounts: {
          none: 0,
          observation: 0,
          mutation: 1,
          indeterminate: 0,
        },
      }),
    );
  });

  test("keeps one caller completion target exact beyond the former summary cap", async () => {
    const fullCompletionTarget = [
      "Establish the complete requested result with every explicit constraint.",
      "x".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH + 512),
      "FULL_COMPLETION_TARGET_END",
    ].join(" ");
    const { ledger, call } = await createReviewerExecutionLedger({
      callerObjective: fullCompletionTarget,
    });
    const snapshot = projectReviewerReviewSnapshot({
      requestId: "request-reviewer-execution",
      requestObjective: REQUEST_SOURCE_PROMPT,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const input = buildReviewerDecisionInput(createReviewerRequest(vi.fn()), {
      call,
      snapshot,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const audit = input.context.messages
      .flatMap((message) => {
        try {
          return [JSON.parse(message.content) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .find(({ kind }) => kind === "runtime_reviewer_audit_v4") as {
      completionTarget: { text: string };
    };

    expect(snapshot.projectionComplete).toBe(true);
    expect(audit.completionTarget.text).toBe(fullCompletionTarget);
    expect(
      input.context.messages.filter(({ content }) =>
        content.includes(fullCompletionTarget),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(input.context.messages)).not.toContain(
      "runtime_request_source_v1",
    );
    expect(JSON.stringify(input.context.messages)).not.toContain(
      OBJECTIVE_SECRET,
    );
  });

  test.each([
    [
      "delegated objective",
      { childObjective: "o".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH + 1) },
    ],
    [
      "returned claim",
      {
        childResultSummary: "r".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH + 1),
      },
    ],
  ])(
    "marks the projection incomplete when a %s is truncated",
    async (_label, options) => {
      const { ledger, call } = await createReviewerExecutionLedger(options);
      const snapshot = projectReviewerReviewSnapshot({
        requestId: "request-reviewer-execution",
        requestObjective: REQUEST_SOURCE_PROMPT,
        ledger,
        call,
        referenceDataBudget: reviewerReferenceDataBudget,
      });
      const format = createReviewerDecisionFormat(snapshot);
      const decisionSchema = (
        format.schema as {
          properties: {
            decision: { properties: { action: { enum: readonly string[] } } };
          };
        }
      ).properties.decision;

      expect(snapshot.projectionComplete).toBe(false);
      expect(decisionSchema.properties.action.enum).toEqual(["report_gaps"]);
    },
  );

  test("keeps the root request as the audit target without promoting observation evidence into claim support", async () => {
    const requestObjective =
      "Compare current GPT research with news.txt and add missing information to the file.";
    const { ledger, call } = await createRootReviewerObservationOnlyLedger();
    const snapshot = projectReviewerReviewSnapshot({
      requestId: "request-reviewer-root",
      requestObjective,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const input = buildReviewerDecisionInput(createReviewerRequest(vi.fn()), {
      call,
      snapshot,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const audit = readReviewerAuditCapsule(input.context.messages);

    expect(snapshot.subjects).toEqual([
      expect.objectContaining({
        subjectRef: "call:call-1",
        kind: "caller_objective",
        summary: requestObjective,
      }),
      expect.objectContaining({
        subjectRef: "call:call-2",
        kind: "planner_result",
      }),
    ]);
    expect(snapshot.facts).toEqual([
      expect.objectContaining({
        kind: "role_result",
        status: "informational",
        subjectRefs: ["call:call-2"],
        evidenceRefs: [],
        summary: "The missing GPT material was appended to news.txt.",
      }),
    ]);
    expect(snapshot.evidence).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        effect: "observation",
        subjectRefs: ["call:call-2"],
      }),
    ]);
    expect(audit.candidateSupportEdges).toEqual([
      {
        sourceSubjectRef: "call:call-2",
        targetSubjectRef: "call:call-1",
        relation: "candidate_support",
      },
    ]);
    expect(audit.claims).toEqual([]);
    expect(audit.effects[0]?.subjectRefs).toEqual(["call:call-2"]);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.reviewer",
      "snapshot.projected",
      expect.objectContaining({
        callerObjectiveSource: "request_source",
        evidenceEffectCounts: {
          none: 0,
          observation: 1,
          mutation: 0,
          indeterminate: 0,
        },
      }),
    );
  });

  test("keeps a prior Reviewer dependency passive while retaining only production support edges", async () => {
    const requestObjective =
      "Complete the root request from the Planner contribution and the later Worker repair.";
    const { ledger, call } = await createRootReviewerAfterPriorReviewLedger();
    const snapshot = projectReviewerReviewSnapshot({
      requestId: "request-reviewer-repeated-cycle",
      requestObjective,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const input = buildReviewerDecisionInput(createReviewerRequest(vi.fn()), {
      call,
      snapshot,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const audit = readReviewerAuditCapsule(input.context.messages);

    expect(snapshot.projectionComplete).toBe(true);
    expect(snapshot.subjects).toEqual([
      expect.objectContaining({
        subjectRef: "call:call-1",
        kind: "caller_objective",
        summary: requestObjective,
      }),
      expect.objectContaining({
        subjectRef: "call:call-2",
        kind: "planner_result",
      }),
      expect.objectContaining({
        subjectRef: "call:call-3",
        kind: "reviewer_result",
      }),
      expect.objectContaining({
        subjectRef: "call:call-4",
        kind: "worker_result",
      }),
    ]);
    expect(snapshot.facts).toEqual([
      expect.objectContaining({
        factRef: "result-1",
        kind: "role_result",
        status: "informational",
        subjectRefs: ["call:call-2"],
      }),
      expect.objectContaining({
        factRef: "result-2",
        kind: "role_result",
        status: "informational",
        subjectRefs: ["call:call-3"],
      }),
      expect.objectContaining({
        factRef: "result-3",
        kind: "role_result",
        status: "informational",
        subjectRefs: ["call:call-4"],
      }),
    ]);
    expect(audit.dependencySubjects).toContainEqual(
      expect.objectContaining({
        producerCallId: "call-3",
        roleId: "reviewer",
        resultRef: "result-2",
        summary: '{"action":"report_gaps","summary":"One repair remains."}',
        presenceEffect:
          "passive_support_not_user_intent_pending_work_completion_or_verdict",
      }),
    );
    expect(JSON.stringify(snapshot)).toContain("One repair remains.");
    expect(audit.candidateSupportEdges).toEqual([
      {
        sourceSubjectRef: "call:call-2",
        targetSubjectRef: "call:call-1",
        relation: "candidate_support",
      },
      {
        sourceSubjectRef: "call:call-4",
        targetSubjectRef: "call:call-1",
        relation: "candidate_support",
      },
    ]);
    expect(audit.claims).toEqual([]);
    expect(audit.effects).toEqual([]);
  });

  test("retains the latest transition per known target without hiding unresolved failures", () => {
    const candidate = (
      executionId: string,
      outcome: "succeeded" | "failed",
      target?: string,
    ) => ({
      executionId,
      outcome,
      observedEffect:
        outcome === "succeeded" ? ("mutation" as const) : ("none" as const),
      summary: `${executionId}:${outcome}`,
      ...(target
        ? { references: [{ kind: "tool_target" as const, target }] }
        : {}),
      subjectRef: "call:call-3",
    });

    expect(
      projectReviewerFinalEvidence(
        [
          candidate("failed-first", "failed", "project/style.css"),
          candidate("successful-retry", "succeeded", "project/style.css"),
        ],
        reviewerReferenceDataBudget,
      ),
    ).toMatchObject({
      evidence: [expect.objectContaining({ evidenceRef: "successful-retry" })],
      sourceExecutionCount: 2,
      supersededExecutionCount: 1,
      retainedFailedExecutionCount: 0,
    });
    expect(
      projectReviewerFinalEvidence(
        [
          candidate("successful-first", "succeeded", "project/style.css"),
          candidate("failed-last", "failed", "project/style.css"),
        ],
        reviewerReferenceDataBudget,
      ).evidence,
    ).toEqual([
      expect.objectContaining({
        evidenceRef: "successful-first",
        outcome: "succeeded",
      }),
      expect.objectContaining({
        evidenceRef: "failed-last",
        outcome: "failed",
      }),
    ]);
    expect(
      projectReviewerFinalEvidence(
        [
          candidate("failed-css", "failed", "project/style.css"),
          candidate("successful-html", "succeeded", "project/index.html"),
        ],
        reviewerReferenceDataBudget,
      ).evidence.map(({ evidenceRef }) => evidenceRef),
    ).toEqual(["failed-css", "successful-html"]);
    expect(
      projectReviewerFinalEvidence(
        [
          candidate("untargeted-failure", "failed"),
          candidate("untargeted-observation-1", "succeeded"),
          candidate("untargeted-observation-2", "succeeded"),
        ],
        reviewerReferenceDataBudget,
      ),
    ).toMatchObject({
      evidence: [
        expect.objectContaining({ evidenceRef: "untargeted-failure" }),
        expect.objectContaining({ evidenceRef: "untargeted-observation-1" }),
        expect.objectContaining({ evidenceRef: "untargeted-observation-2" }),
      ],
      retainedFailedExecutionCount: 1,
      retainedUntargetedExecutionCount: 3,
    });
  });

  test("retains the nearest successful pre-mutation observation for the current target", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-before-edit", "observation", {
          referenceData: "before",
        }),
        reviewerTargetCandidate("edit-current-target", "mutation", {
          referenceData: "after",
        }),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection).toMatchObject({
      projectionComplete: true,
      supersededExecutionCount: 0,
      evidence: [
        expect.objectContaining({
          evidenceRef: "read-before-edit",
          effect: "observation",
          referenceData: "before",
        }),
        expect.objectContaining({
          evidenceRef: "edit-current-target",
          effect: "mutation",
          referenceData: "after",
        }),
      ],
    });
  });

  test("retains every successful pre-mutation observation since the prior state change", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("full-file-inspect", "observation"),
        reviewerTargetCandidate("repository-state-observation", "observation"),
        reviewerTargetCandidate("current-mutation", "mutation"),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection).toMatchObject({
      supersededExecutionCount: 0,
    });
    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "full-file-inspect",
      "repository-state-observation",
      "current-mutation",
    ]);
  });

  test("keeps failure and retry supersession while retaining the successful retry witness", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-before-attempts", "observation"),
        reviewerTargetCandidate("failed-attempt", "none", {
          outcome: "failed",
        }),
        reviewerTargetCandidate("successful-retry", "mutation"),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection).toMatchObject({
      supersededExecutionCount: 1,
      retainedFailedExecutionCount: 0,
    });
    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "read-before-attempts",
      "successful-retry",
    ]);
  });

  test("prioritizes current evidence over a pre-mutation witness at the evidence limit", () => {
    const currentUntargetedEvidence = Array.from(
      { length: REVIEWER_MAX_EVIDENCE - 3 },
      (_, index) => ({
        executionId: `current-untargeted-${index}`,
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: `Current untargeted observation ${index}.`,
        subjectRef: "call:call-3",
      }),
    );
    const projection = projectReviewerFinalEvidence(
      [
        ...currentUntargetedEvidence,
        reviewerTargetCandidate("bounded-full-inspect", "observation"),
        reviewerTargetCandidate("bounded-git-observation", "observation"),
        reviewerTargetCandidate("current-mutation-at-limit", "mutation"),
        reviewerTargetCandidate("current-verify-read-at-limit", "observation"),
        reviewerTargetCandidate("current-failure-at-limit", "none", {
          outcome: "failed",
        }),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection.projectionComplete).toBe(false);
    expect(projection.supersededExecutionCount).toBe(0);
    expect(projection.evidence).toHaveLength(REVIEWER_MAX_EVIDENCE);
    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toContain(
      "current-mutation-at-limit",
    );
    expect(
      projection.evidence.map(({ evidenceRef }) => evidenceRef),
    ).not.toContain("bounded-full-inspect");
    expect(
      projection.evidence.map(({ evidenceRef }) => evidenceRef),
    ).not.toContain("bounded-git-observation");
    expect(
      projection.evidence.slice(-3).map(({ evidenceRef }) => evidenceRef),
    ).toEqual([
      "current-mutation-at-limit",
      "current-verify-read-at-limit",
      "current-failure-at-limit",
    ]);
  });

  test("does not reuse an observation across two successful mutations", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-0", "observation"),
        reviewerTargetCandidate("mutation-1", "mutation"),
        reviewerTargetCandidate("mutation-2", "mutation"),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "mutation-2",
    ]);
    expect(projection.supersededExecutionCount).toBe(2);
  });

  test.each(["mutation", "indeterminate"] as const)(
    "does not reuse an observation across a failed %s effect",
    (failedEffect) => {
      const projection = projectReviewerFinalEvidence(
        [
          reviewerTargetCandidate("read-0", "observation"),
          reviewerTargetCandidate("failed-state-change", failedEffect, {
            outcome: "failed",
          }),
          reviewerTargetCandidate("successful-mutation", "mutation"),
        ],
        reviewerReferenceDataBudget,
      );

      expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual(
        ["successful-mutation"],
      );
      expect(projection.supersededExecutionCount).toBe(2);
    },
  );

  test.each(["mutation", "indeterminate"] as const)(
    "pins a failed %s transition and its witness across a later verify-read",
    (failedEffect) => {
      const projection = projectReviewerFinalEvidence(
        [
          reviewerTargetCandidate("read-before-failure", "observation"),
          reviewerTargetCandidate("failed-state-change", failedEffect, {
            outcome: "failed",
          }),
          reviewerTargetCandidate("verify-read", "observation"),
        ],
        reviewerReferenceDataBudget,
      );

      expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual(
        ["read-before-failure", "failed-state-change", "verify-read"],
      );
      expect(projection.retainedFailedExecutionCount).toBe(1);
    },
  );

  test("retains separate witnesses for the latest successful and state-changing transitions", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-before-success", "observation"),
        reviewerTargetCandidate("successful-mutation", "mutation"),
        reviewerTargetCandidate("read-before-failure", "observation"),
        reviewerTargetCandidate("failed-state-change", "indeterminate", {
          outcome: "failed",
        }),
        reviewerTargetCandidate("current-verify-read", "observation"),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "read-before-success",
      "successful-mutation",
      "read-before-failure",
      "failed-state-change",
      "current-verify-read",
    ]);
    expect(projection.retainedFailedExecutionCount).toBe(1);
  });

  test("retains the latest mutation transition when a verify-read is current", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-before-mutation", "observation"),
        reviewerTargetCandidate("successful-mutation", "mutation"),
        reviewerTargetCandidate("verify-read", "observation"),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "read-before-mutation",
      "successful-mutation",
      "verify-read",
    ]);
  });

  test("retains all still-current observations before a later no-effect failure", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-before-mutation", "observation"),
        reviewerTargetCandidate("successful-mutation", "mutation"),
        reviewerTargetCandidate("verify-read-full", "observation"),
        reviewerTargetCandidate("verify-read-metadata", "observation"),
        reviewerTargetCandidate("latest-no-effect-failure", "none", {
          outcome: "failed",
        }),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "read-before-mutation",
      "successful-mutation",
      "verify-read-full",
      "verify-read-metadata",
      "latest-no-effect-failure",
    ]);
    expect(projection.retainedFailedExecutionCount).toBe(1);
  });

  test("retains the latest successful mutation transition before a current failure", () => {
    const projection = projectReviewerFinalEvidence(
      [
        reviewerTargetCandidate("read-before-mutation", "observation"),
        reviewerTargetCandidate("successful-mutation", "mutation"),
        reviewerTargetCandidate("latest-failure", "none", {
          outcome: "failed",
        }),
      ],
      reviewerReferenceDataBudget,
    );

    expect(projection.evidence.map(({ evidenceRef }) => evidenceRef)).toEqual([
      "read-before-mutation",
      "successful-mutation",
      "latest-failure",
    ]);
    expect(projection.retainedFailedExecutionCount).toBe(1);
  });

  test("retains a capability-summary continuation before allowing pass", () => {
    const projection = projectReviewerFinalEvidence(
      [
        {
          executionId: "long-summary-execution",
          outcome: "succeeded",
          observedEffect: "mutation",
          summary: "s".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH + 1),
          subjectRef: "requirement:landing-page",
        },
      ],
      reviewerReferenceDataBudget,
    );
    const snapshot: ReviewerReviewSnapshot = {
      ...reviewSnapshot,
      projectionComplete: projection.projectionComplete,
      evidence: projection.evidence,
    };
    const decisionSchema = (
      createReviewerDecisionFormat(snapshot).schema as {
        properties: {
          decision: {
            anyOf: readonly {
              properties: { action: { enum: readonly string[] } };
            }[];
          };
        };
      }
    ).properties.decision;

    expect(projection).toMatchObject({
      projectionComplete: true,
      sourceReferenceDataCount: 1,
      retainedReferenceDataCount: 1,
      omittedReferenceDataCount: 0,
      evidence: [
        expect.objectContaining({
          evidenceRef: "long-summary-execution",
          summary: "s".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH),
          referenceData: expect.stringContaining(
            '"kind":"runtime_reviewer_evidence_summary_continuation_v1"',
          ),
        }),
      ],
    });
    expect(
      decisionSchema.anyOf.map(({ properties }) => properties.action.enum),
    ).toEqual([["pass"], ["report_gaps"]]);
    expect(
      parseReviewerDecisionOutput(
        encodeReviewerDecision(
          {
            action: "pass",
            reviewScopeId: snapshot.reviewScopeId,
            summary: "The truncated execution summary was sufficient.",
            gaps: [],
          },
          snapshot,
        ),
        { snapshot },
      ),
    ).toMatchObject({ ok: true, decision: { action: "pass" } });
  });

  test("retains four current artifact snapshots in full when the resolved Reviewer budget fits them", () => {
    const sources = ["h", "c", "j", "d"].map((character) =>
      character.repeat(9_000),
    );
    const candidate = (
      executionId: string,
      target: string,
      referenceData: string,
    ) => ({
      executionId,
      outcome: "succeeded" as const,
      observedEffect: "mutation" as const,
      summary: `Established ${target}.`,
      referenceData,
      references: [{ kind: "tool_target" as const, target }],
      subjectRef: "call:call-3",
    });
    const lunaSizedBudget: ReviewerReferenceDataBudget = {
      maxTokens: 10_000,
      tokenEstimation: { asciiCharactersPerToken: 4 },
    };
    const projection = projectReviewerFinalEvidence(
      [
        candidate("superseded-html", "project/index.html", "old"),
        candidate("final-html", "project/index.html", sources[0]!),
        candidate("final-css", "project/styles.css", sources[1]!),
        candidate("final-js", "project/app.js", sources[2]!),
        candidate("final-json", "project/products.json", sources[3]!),
      ],
      lunaSizedBudget,
    );

    expect(
      projection.evidence.map(({ referenceData }) => referenceData),
    ).toEqual(sources);
    expect(projection).toMatchObject({
      projectionComplete: true,
      supersededExecutionCount: 1,
      retainedReferenceDataCount: 4,
      retainedReferenceDataChars: 36_000,
      omittedReferenceDataCount: 0,
      omittedReferenceDataChars: 0,
    });
  });

  test("bounds larger final evidence while representing every current target fairly", () => {
    const referenceDataBudget: ReviewerReferenceDataBudget = {
      maxTokens: 4_000,
      tokenEstimation: { asciiCharactersPerToken: 4 },
    };
    const projection = projectReviewerFinalEvidence(
      ["html", "css", "js", "json"].map((name) => ({
        executionId: `final-${name}`,
        outcome: "succeeded" as const,
        observedEffect: "mutation" as const,
        summary: `Established ${name}.`,
        referenceData: name[0]!.repeat(32_768),
        references: [
          { kind: "tool_target" as const, target: `project/${name}` },
        ],
        subjectRef: "call:call-3",
      })),
      referenceDataBudget,
    );
    const projectedData = projection.evidence.map(
      ({ referenceData }) => referenceData,
    );

    expect(projectedData).toHaveLength(4);
    expect(projectedData.every(Boolean)).toBe(true);
    expect(
      projectedData.every((value) =>
        value!.includes("[runtime projection omitted"),
      ),
    ).toBe(true);
    expect(
      projectedData.reduce(
        (total, value) =>
          total +
          estimateReferenceDataTokens(
            value!,
            referenceDataBudget.tokenEstimation,
          ),
        0,
      ),
    ).toBeLessThanOrEqual(referenceDataBudget.maxTokens);
    expect(projection).toMatchObject({
      projectionComplete: false,
      retainedReferenceDataCount: 4,
      omittedReferenceDataCount: 4,
    });
    const retainedPerTarget = projectedData.map(
      (value) =>
        value!.replace(/\n?\[runtime projection omitted.*?\]\n?/g, "").length,
    );
    expect(
      Math.max(...retainedPerTarget) - Math.min(...retainedPerTarget),
    ).toBeLessThanOrEqual(4);
  });

  test("derives Luna-sized evidence capacity after the real base prompt and keeps the final prompt bounded", () => {
    const sources = ["h", "c", "j", "d"].map((character) =>
      character.repeat(9_000),
    );
    const targets = [
      "project/index.html",
      "project/styles.css",
      "project/app.js",
      "project/products.json",
    ];
    const candidates = targets.map((target, index) => ({
      executionId: `final-${index}`,
      outcome: "succeeded" as const,
      observedEffect: "mutation" as const,
      summary: `Established ${target}.`,
      referenceData: sources[index]!,
      references: [{ kind: "tool_target" as const, target }],
      subjectRef: "call:call-3",
    }));
    const request = createReviewerRequest(vi.fn());
    const lunaRequest = deriveTestRequestExecutionScope(request, {
      runnerConfig: {
        ...request.runnerConfig,
        context: {
          outputReserveTokens: 4_096,
          safetyReserveTokens: 1_200,
          attachmentReserveTokens: 1_024,
        },
      },
      modelPolicy: {
        ...modelPolicy,
        profiles: {
          "runtime-default": {
            ...modelPolicy.profiles["runtime-default"],
            contextWindowTokens: 32_768,
            context: {
              tokenEstimation: { asciiCharactersPerToken: 4 },
            },
            calibration: {
              "reviewer.decision": {},
            },
          },
        },
      },
    });
    const budget = resolveReviewerDecisionContextBudget(lunaRequest);
    const emptyBudget: ReviewerReferenceDataBudget = {
      maxTokens: 0,
      tokenEstimation: budget.tokenEstimation,
    };
    const snapshotSubjects = [
      ...reviewSnapshot.subjects,
      {
        subjectRef: "call:call-3",
        kind: "worker_result",
        summary: "Current implementation artifacts.",
      },
    ];
    const baseSnapshot: ReviewerReviewSnapshot = {
      ...reviewSnapshot,
      projectionComplete: false,
      subjects: snapshotSubjects,
      facts: [],
      evidence: projectReviewerFinalEvidence(candidates, emptyBudget).evidence,
    };
    const baseAssessment = assessReviewerDecisionInputBudget(lunaRequest, {
      call: reviewerCall,
      snapshot: baseSnapshot,
      budget,
    });
    const referenceDataBudget: ReviewerReferenceDataBudget = {
      maxTokens:
        baseAssessment.budget.availableInputTokens -
        baseAssessment.budget.estimatedInputTokens,
      tokenEstimation: budget.tokenEstimation,
    };
    const projection = projectReviewerFinalEvidence(
      candidates,
      referenceDataBudget,
    );
    const finalSnapshot: ReviewerReviewSnapshot = {
      ...baseSnapshot,
      projectionComplete: projection.projectionComplete,
      evidence: projection.evidence,
    };
    const input = buildReviewerDecisionInput(lunaRequest, {
      call: reviewerCall,
      snapshot: finalSnapshot,
      budget,
      referenceDataBudget,
    });

    expect(
      input.snapshot.evidence.map(({ referenceData }) => referenceData),
    ).toEqual(sources);
    expect(input.context.budget.estimatedInputTokens).toBeLessThanOrEqual(
      input.context.budget.availableInputTokens,
    );
  });

  test("projects an applicable Worker checkpoint digest without its raw evidence or continuation", async () => {
    const { ledger, call } = await createReviewerExecutionLedger();
    const request = createReviewerRequest(vi.fn());
    const digest = "The requested artifact was created and verified.";
    const executionId = commitWorkerEvidenceCheckpoint({
      request,
      ledger,
      workerCallId: "call-3",
      digest,
    });

    const snapshotWithoutCheckpoint = projectReviewerReviewSnapshot({
      requestId: request.requestId,
      requestObjective: request.prompt,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
    });
    const snapshot = projectReviewerReviewSnapshot({
      requestId: request.requestId,
      requestObjective: request.prompt,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
      contextCompactionStore: request.contextCompactionStore,
    });
    const rawProjection = snapshotWithoutCheckpoint.evidence[0]?.referenceData;
    const compactedProjection = snapshot.evidence[0]?.referenceData;

    expect(rawProjection).toBe(EVIDENCE_REFERENCE_DATA_SECRET);
    expect(compactedProjection).not.toContain(EVIDENCE_REFERENCE_DATA_SECRET);
    expect(compactedProjection).not.toContain(
      "Return the completed result to the caller.",
    );
    expect(JSON.parse(compactedProjection!)).toEqual({
      kind: "runtime_reviewer_compacted_evidence_v1",
      authority: "runtime_semantic_compaction_checkpoint",
      purpose: "reviewer_evidence_projection",
      presenceEffect: "passive_evidence_not_user_intent_routing_or_completion",
      checkpoint: {
        scopeId: workerCapabilityContextCompactionScopeId("call-3"),
        sourceRevision: ledger.current().revision,
      },
      source: {
        sourceRef: executionId,
        sourceFingerprint: expect.stringMatching(/^sha256:/u),
        digest,
      },
    });
    expect(snapshot.projectionComplete).toBe(true);
  });

  test("keeps covered Reviewer evidence below the compaction trigger without invoking a second compaction", async () => {
    const rawEvidence = "R".repeat(30_000);
    const { ledger, call } = await createReviewerExecutionLedger({
      referenceData: rawEvidence,
    });
    let responseSnapshot = reviewSnapshot;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const serializedMessages = JSON.stringify(input.messages);
      expect(serializedMessages).toContain(
        "runtime_reviewer_compacted_evidence_v1",
      );
      expect(serializedMessages).not.toContain(rawEvidence);
      return {
        text: encodeReviewerDecision(
          {
            action: "pass",
            reviewScopeId: `review:${call.callId}:r${ledger.current().revision}`,
            summary: "The compacted evidence establishes completion.",
            gaps: [],
          },
          responseSnapshot,
        ),
        meta: {},
      };
    });
    const request = createReviewerRequest(invoke);
    commitWorkerEvidenceCheckpoint({
      request,
      ledger,
      workerCallId: "call-3",
      digest: "The exact bounded artifact was created successfully.",
    });
    responseSnapshot = projectReviewerReviewSnapshot({
      requestId: request.requestId,
      requestObjective: request.prompt,
      ledger,
      call,
      referenceDataBudget: reviewerReferenceDataBudget,
      contextCompactionStore: request.contextCompactionStore,
    });

    await expect(
      GENERIC_REVIEWER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["planner", "worker", "reviewer"],
      }),
    ).resolves.toMatchObject({
      kind: "terminal",
      outcome: "completed",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(request.onEvent)
        .mock.calls.some(([name]) => name === "context.compaction.started"),
    ).toBe(false);
  });

  test.each(["pass", "report_gaps"] as const)(
    "returns a %s verdict to the caller as a completed role result",
    async (action) => {
      const { ledger, call } = await createReviewerExecutionLedger();
      const snapshot = projectReviewerReviewSnapshot({
        requestId: "request-reviewer-execution",
        requestObjective: REQUEST_SOURCE_PROMPT,
        ledger,
        call,
        referenceDataBudget: reviewerReferenceDataBudget,
      });
      const decision =
        action === "pass"
          ? {
              action,
              reviewScopeId: snapshot.reviewScopeId,
              summary: "High-level completion is established.",
              gaps: [],
            }
          : {
              action,
              reviewScopeId: snapshot.reviewScopeId,
              summary: "One high-level gap remains.",
              gaps: [
                {
                  kind: "missing_artifact",
                  subjectRefs: [],
                  factRefs: [],
                  evidenceRefs: [],
                  summary: "A requested artifact is not represented.",
                },
              ],
            };
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        const parsedMessages = (
          input.messages as readonly Readonly<{
            content: string;
          }>[]
        ).flatMap((message) => {
          try {
            return [JSON.parse(message.content) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
        const toolResultBlocks = parsedMessages.filter(
          ({ kind }) => kind === "runtime_request_tool_results_v1",
        );
        expect(toolResultBlocks).toEqual([]);
        const audit = parsedMessages.find(
          ({ kind }) => kind === "runtime_reviewer_audit_v4",
        );
        expect(audit).toMatchObject({
          auditScope: {
            reviewScopeId: snapshot.reviewScopeId,
            sourceRevision: snapshot.sourceRevision,
          },
          completionTarget: {
            authority: "caller",
            text: snapshot.subjects.find(
              ({ kind }) => kind === "caller_objective",
            )!.summary,
          },
        });
        return {
          text: encodeReviewerDecision(decision, snapshot),
          meta: {},
        };
      });
      const request = createReviewerRequest(invoke);
      const projectedSnapshotCountBeforeExecution =
        mocks.traceDebug.mock.calls.filter(
          ([scope, event]) =>
            scope === "runtime.reviewer" && event === "snapshot.projected",
        ).length;

      await expect(
        GENERIC_REVIEWER_EXECUTOR.execute({
          context: request,
          call,
          ledger,
          availableChildRoleIds: ["planner", "worker", "reviewer"],
        }),
      ).resolves.toEqual({
        kind: "terminal",
        outcome: "completed",
        summary: decision.summary,
        receipt: {
          kind: "reviewer_verdict_v1",
          reviewerCallId: call.callId,
          callerCallId: snapshot.callerCallId,
          reviewScopeId: snapshot.reviewScopeId,
          sourceRevision: snapshot.sourceRevision,
          verdict: decision.action,
          gaps: decision.gaps,
        },
      });
      expect(ledger.current().state.activeCallId).toBe(call.callId);
      expect(
        vi
          .mocked(request.onEvent)
          .mock.calls.filter(([name]) => name === "runtime.state"),
      ).toEqual([
        [
          "runtime.state",
          {
            stage: "reviewer",
            phase: "reviewing",
            message: "Reviewing high-level completion...",
          },
        ],
      ]);
      expect(
        mocks.traceDebug.mock.calls.filter(
          ([scope, event]) =>
            scope === "runtime.reviewer" && event === "snapshot.projected",
        ).length,
      ).toBe(projectedSnapshotCountBeforeExecution + 1);
    },
  );

  test("logs provider completion metadata before surfacing output_incomplete", async () => {
    const invalidOutput =
      "INVALID_REVIEWER_MODEL_OUTPUT_MUST_NOT_REACH_LOGS ".repeat(20);
    const { ledger, call } = await createReviewerExecutionLedger();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: invalidOutput,
      meta: {
        outputLength: invalidOutput.length,
        terminalEventCount: 1,
        providerCompletionReason: "length",
        usage: {
          inputTokens: 655,
          outputTokens: 2_048,
          totalTokens: 2_703,
        },
      },
    }));
    const request = createReviewerRequest(invoke);

    await expect(
      GENERIC_REVIEWER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["planner", "worker", "reviewer"],
      }),
    ).rejects.toMatchObject({
      name: "ModelOutputIncompleteError",
      code: "output_incomplete",
      providerCompletionReason: "length",
      providerOutputTokens: 2_048,
    });

    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.model",
      "step.output_received",
      expect.objectContaining({
        requestId: "request-reviewer-execution",
        modelStep: REVIEWER_DECISION_MODEL_STEP,
        outputLength: invalidOutput.length,
        transportOutputLength: invalidOutput.length,
        terminalEventCount: 1,
        providerCompletionReason: "length",
        providerInputTokens: 655,
        providerOutputTokens: 2_048,
        providerTotalTokens: 2_703,
      }),
    );
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.model",
      "step.output_incomplete",
      expect.objectContaining({
        issueCode: "output_incomplete",
        validationStage: "provider_completion",
        providerCompletionReason: "length",
        providerOutputTokens: 2_048,
      }),
    );
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.model",
      "step.failed",
      expect.objectContaining({
        responseReceived: true,
        providerCompletionReason: "length",
        providerOutputTokens: 2_048,
      }),
    );
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.reviewer",
      "model.failed",
      expect.objectContaining({
        invalidStructuredOutput: false,
      }),
    );

    const eventOrder = mocks.traceDebug.mock.calls.map(
      ([scope, event]) => `${scope}:${event}`,
    );
    expect(
      eventOrder.indexOf("runtime.model:step.output_received"),
    ).toBeLessThan(eventOrder.indexOf("runtime.model:step.output_incomplete"));
    expect(
      eventOrder.indexOf("runtime.model:step.output_incomplete"),
    ).toBeLessThan(eventOrder.indexOf("runtime.model:step.failed"));
    expect(eventOrder).not.toContain(
      "runtime.reviewer:output.envelope.rejected",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.traceDebug.mock.calls)).not.toContain(
      "INVALID_REVIEWER_MODEL_OUTPUT_MUST_NOT_REACH_LOGS",
    );
  });
});
