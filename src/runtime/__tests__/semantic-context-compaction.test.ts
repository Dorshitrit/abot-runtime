import { describe, expect, test, vi } from "vitest";

import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  CONTEXT_COMPACTION_MODEL_STEP,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint,
  generateSemanticCompactionCandidate,
  parseSemanticCompactionOutput,
  type SemanticCompactionContinuation,
} from "../context/semantic-compaction/index.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/index.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  runWorkerDecision,
  WORKER_DECISION_MODEL_STEP,
  WORKER_RESULT_MODEL_STEP,
} from "../steps/worker-decision/index.js";

type TestModelMessage = Readonly<{ role: string; content: string }>;

function readModelMessages(value: unknown): readonly TestModelMessage[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected model messages to be an array.");
  }
  const messages = value.filter(
    (message): message is TestModelMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      typeof message.role === "string" &&
      "content" in message &&
      typeof message.content === "string",
  );
  if (messages.length !== value.length) {
    throw new TypeError(
      "Expected every model message to contain text content.",
    );
  }
  return messages;
}

function createContinuation(
  overrides: Partial<SemanticCompactionContinuation> = {},
): SemanticCompactionContinuation {
  return Object.freeze({
    completed: Object.freeze(["Compacted the supplied source evidence."]),
    currentState: "The semantic checkpoint is current.",
    findings: Object.freeze(["Preserved the task-relevant source facts."]),
    evidenceRefs: Object.freeze([]),
    artifacts: Object.freeze([]),
    decisions: Object.freeze([]),
    failedApproaches: Object.freeze([]),
    openWork: Object.freeze(["Continue the active role objective."]),
    blockers: Object.freeze([]),
    nextStep: "Resume from the semantic checkpoint.",
    ...overrides,
  });
}

function createCumulativeContinuation(
  sourceRefs: readonly string[],
  previous?: SemanticCompactionContinuation,
): SemanticCompactionContinuation {
  return createContinuation({
    completed: Object.freeze([
      ...(previous?.completed ?? []),
      ...sourceRefs.map((sourceRef) => `Compacted ${sourceRef}.`),
    ]),
    currentState: `Covered through ${sourceRefs.at(-1) ?? "the prior source"}.`,
    findings: Object.freeze([
      ...(previous?.findings ?? []),
      ...sourceRefs.map((sourceRef) => `Task-relevant ${sourceRef} facts.`),
    ]),
    evidenceRefs: Object.freeze([
      ...(previous?.evidenceRefs ?? []),
      ...sourceRefs,
    ]),
    artifacts: Object.freeze([...(previous?.artifacts ?? [])]),
    decisions: Object.freeze([...(previous?.decisions ?? [])]),
    failedApproaches: Object.freeze([...(previous?.failedApproaches ?? [])]),
    openWork: Object.freeze(["Continue the active Worker objective."]),
    blockers: Object.freeze([...(previous?.blockers ?? [])]),
    nextStep:
      "Continue the active Worker objective without rereading evidence.",
  });
}

describe("semantic request-context compaction", () => {
  test("binds ordered semantic digests to runtime-owned source identities", () => {
    const sourceFingerprintA = createSemanticCompactionSha256Fingerprint(
      "The complete source fact.",
    );
    const sourceFingerprintB = createSemanticCompactionSha256Fingerprint(
      "The second complete source fact.",
    );
    const expectedSources = [
      { sourceRef: "execution-1", sourceFingerprint: sourceFingerprintA },
      { sourceRef: "execution-2", sourceFingerprint: sourceFingerprintB },
    ];
    const continuation = createContinuation();
    expect(
      parseSemanticCompactionOutput(
        JSON.stringify({
          continuation,
          sourceDigests: ["  Fact A.  ", "Fact B."],
        }),
        expectedSources,
      ),
    ).toEqual({
      ok: true,
      continuation,
      sourceDigests: [
        {
          sourceRef: "execution-1",
          sourceFingerprint: sourceFingerprintA,
          digest: "Fact A.",
        },
        {
          sourceRef: "execution-2",
          sourceFingerprint: sourceFingerprintB,
          digest: "Fact B.",
        },
      ],
    });
    expect(
      parseSemanticCompactionOutput(
        JSON.stringify({
          continuation,
          sourceDigests: [
            { sourceRef: "execution-2", digest: "Fact A." },
            { sourceRef: "execution-1", digest: "Fact B." },
          ],
        }),
        expectedSources,
      ),
    ).toEqual({
      ok: false,
      issueCode: "context_compaction_source_invalid",
    });
    expect(
      parseSemanticCompactionOutput(
        JSON.stringify({
          continuation,
          sourceDigests: [sourceFingerprintA, "Fact B."],
        }),
        expectedSources,
      ),
    ).toEqual({
      ok: false,
      issueCode: "context_compaction_digest_not_semantic",
    });
  });

  test("surfaces a digest stopped at the provider output limit", async () => {
    const prompt = "Preserve the exact source facts.";
    const preservationObjective = "Preserve the observed fact.";
    const sourceContent = "The complete source fact.";
    const invoke = vi.fn<ModelGatewayClient["invoke"]>().mockResolvedValueOnce({
      text: JSON.stringify({
        continuation: createContinuation(),
        sourceDigests: ["Partial fact."],
      }),
      meta: { providerCompletionReason: "max_output_tokens" },
    });
    const request = createTestRequestExecutionScope({
      requestId: "compact-output-limit",
      sessionId: "compact-output-limit-session",
      prompt,
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig: {
        models: {
          defaults: {
            profileId: "compact-test-profile",
            steps: {
              [CONTEXT_COMPACTION_MODEL_STEP]: "compact-test-profile",
            },
          },
        },
        context: {
          outputReserveTokens: 2_048,
          safetyReserveTokens: 500,
          attachmentReserveTokens: 100,
        },
        steps: {
          [CONTEXT_COMPACTION_MODEL_STEP]: { timeoutMs: 20_000 },
        },
      },
      agentMode: "reasoning",
      modelPolicy: {
        providers: {
          test: { type: "ollama" },
        },
        profiles: {
          "compact-test-profile": {
            provider: "test",
            model: "compact-test-model",
            contextWindowTokens: 16_000,
          },
        },
        defaults: {
          profileId: "compact-test-profile",
          steps: {
            [CONTEXT_COMPACTION_MODEL_STEP]: "compact-test-profile",
          },
        },
      },
      modelGatewayClient: { invoke, invokeRaw: vi.fn() },
      abortSignal: new AbortController().signal,
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([]),
        getAdapters: () => Object.freeze([]),
      },
      toolPermissionMode: "full_access",
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    });

    await expect(
      generateSemanticCompactionCandidate({
        request,
        scopeId: "worker:call-1:evidence",
        binding: {
          requestId: "compact-output-limit",
          currentRequestFingerprint:
            createSemanticCompactionSha256Fingerprint(prompt),
          roleId: "worker",
          callId: "call-1",
          objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
            preservationObjective,
          ),
          contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
          allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
        },
        sourceRevision: 1,
        preservationObjective,
        sources: [
          {
            sourceRef: "execution-1",
            sourceFingerprint:
              createSemanticCompactionSha256Fingerprint(sourceContent),
            content: sourceContent,
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "ModelOutputIncompleteError",
      code: "output_incomplete",
      providerCompletionReason: "max_output_tokens",
    });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("summarizes exact Worker evidence once and skips summary-only handoff receipts", async () => {
    const runnerConfig: RequestRunnerConfig = {
      models: {
        defaults: {
          profileId: "test-model",
          steps: {
            [WORKER_DECISION_MODEL_STEP]: "worker.decision",
            [WORKER_RESULT_MODEL_STEP]: "worker.result",
            [CONTEXT_COMPACTION_MODEL_STEP]: "context.compact",
          },
        },
      },
      context: {
        outputReserveTokens: 2_048,
        safetyReserveTokens: 500,
        attachmentReserveTokens: 100,
      },
      steps: {
        [WORKER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
        [WORKER_RESULT_MODEL_STEP]: { timeoutMs: 20_000 },
        [CONTEXT_COMPACTION_MODEL_STEP]: { timeoutMs: 20_000 },
      } as RequestRunnerConfig["steps"],
    };
    const modelPolicy = {
      providers: {
        test: { type: "ollama" as const },
      },
      profiles: {
        "test-model": {
          provider: "test",
          model: "test-model",
          contextWindowTokens: 16_000,
          context: {
            tokenEstimation: {
              asciiCharactersPerToken: 1,
              nonAsciiBytesPerToken: 2,
              messageOverheadTokens: 6,
            },
          },
          calibration: {
            "worker.decision": {},
            "worker.result": {},
            "context.compact": {},
          },
        },
      },
      defaults: {
        profileId: "test-model",
        steps: {
          [WORKER_DECISION_MODEL_STEP]: "worker.decision",
          [WORKER_RESULT_MODEL_STEP]: "worker.result",
          [CONTEXT_COMPACTION_MODEL_STEP]: "context.compact",
        },
      },
    };
    const modelInputs: Parameters<ModelGatewayClient["invoke"]>[0][] = [];
    let authorResult = false;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      modelInputs.push(input);
      const compactionInput =
        input.modelStep === CONTEXT_COMPACTION_MODEL_STEP
          ? (JSON.parse(readModelMessages(input.messages).at(-1)!.content) as {
              newSources?: readonly { sourceRef: string }[];
              previousContinuation?: SemanticCompactionContinuation;
              previousCheckpoint?: Readonly<{
                continuation: SemanticCompactionContinuation;
              }>;
              partialSourceFold?: Readonly<{
                continuation: SemanticCompactionContinuation;
              }>;
              sourceSlice?: Readonly<{ sourceRef: string }>;
            })
          : undefined;
      const compactedSourceRefs = compactionInput
        ? (compactionInput.newSources?.map(({ sourceRef }) => sourceRef) ??
          (compactionInput.sourceSlice
            ? [compactionInput.sourceSlice.sourceRef]
            : []))
        : [];
      const previousContinuation =
        compactionInput?.partialSourceFold?.continuation ??
        compactionInput?.previousContinuation ??
        compactionInput?.previousCheckpoint?.continuation;
      return {
        text: compactionInput
          ? JSON.stringify({
              continuation: createCumulativeContinuation(
                compactedSourceRefs,
                previousContinuation,
              ),
              sourceDigests: compactedSourceRefs.map(
                (sourceRef) => `Task-relevant ${sourceRef} facts.`,
              ),
            })
          : input.modelStep === WORKER_RESULT_MODEL_STEP
            ? "Compacted evidence handoff."
            : JSON.stringify({
                decision: {
                  ...(authorResult
                    ? { action: "return_result" }
                    : {
                        action: "return_failure",
                        reason: "Test stop after context projection.",
                      }),
                },
              }),
        meta: {},
      };
    });
    const onEvent = vi.fn();
    const contextCompactionStore = createRequestContextCompactionStore();
    const request = createTestRequestExecutionScope({
      requestId: "compact-request",
      sessionId: "compact-session",
      prompt: "Use the collected evidence.",
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig,
      agentMode: "reasoning",
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw: vi.fn() },
      contextCompactionStore,
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
      onEvent,
    });
    const call: RoleCallFrame = Object.freeze({
      callId: "call-worker",
      parentCallId: "call-root",
      roleId: "worker",
      depth: 1,
      objective: "Use all source facts.",
      dependencyResultRefs: [],
      status: "active",
      childCallIds: [],
      activationCount: 1,
      resultRef: null,
    });
    const requestToolResults: RequestToolResultsView = Object.freeze({
      sourceRevision: 9,
      results: Object.freeze(
        [1, 2, 3].map((index) =>
          Object.freeze({
            executionId: `execution-${index}`,
            callId: call.callId,
            invocationAttempt: index,
            capabilityId: "example.observe",
            declaredEffect: "observation" as const,
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: `Observed source ${index}.`,
            referenceData: `RAW_EVIDENCE_${index}:`.repeat(500),
            references: Object.freeze([
              Object.freeze({
                kind: "tool_target" as const,
                target: `evidence/source-${index}.md`,
              }),
            ]),
          }),
        ),
      ),
    });

    await runWorkerDecision(request, { call, requestToolResults });
    await runWorkerDecision(request, { call, requestToolResults });

    const firstCompactionInputs = modelInputs.filter(
      ({ modelStep }) => modelStep === CONTEXT_COMPACTION_MODEL_STEP,
    );
    expect(firstCompactionInputs).toHaveLength(3);
    expect(
      firstCompactionInputs.flatMap(({ messages }) => {
        const payload = JSON.parse(
          readModelMessages(messages).at(-1)!.content,
        ) as {
          newSources: readonly { sourceRef: string }[];
        };
        expect(payload.newSources).toHaveLength(1);
        return payload.newSources.map(({ sourceRef }) => sourceRef);
      }),
    ).toEqual(["execution-1", "execution-2", "execution-3"]);
    const firstWorkerInputs = modelInputs.filter(
      ({ modelStep }) => modelStep === WORKER_DECISION_MODEL_STEP,
    );
    expect(firstWorkerInputs).toHaveLength(2);
    expect(JSON.stringify(firstWorkerInputs[0]!.messages)).toContain(
      "coveredResults",
    );
    expect(JSON.stringify(firstWorkerInputs[0]!.messages)).toContain(
      "evidence/source-1.md",
    );
    expect(JSON.stringify(firstWorkerInputs[0]!.messages)).toContain(
      "Task-relevant execution-1 facts.",
    );
    expect(JSON.stringify(firstWorkerInputs[0]!.messages)).not.toContain(
      "RAW_EVIDENCE_1",
    );
    expect(
      contextCompactionStore.get(`worker:${call.callId}:request-tool-results`),
    ).toMatchObject({
      kind: "runtime_semantic_compaction_checkpoint_v2",
      requestId: "compact-request",
      currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
        "Use the collected evidence.",
      ),
      roleId: "worker",
      callId: call.callId,
      objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
        call.objective!,
      ),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
      sourceRevision: 9,
      sourceDigests: requestToolResults.results.map((result) => ({
        sourceRef: result.executionId,
        sourceFingerprint: createSemanticCompactionSha256Fingerprint(
          JSON.stringify(result),
        ),
        digest: `Task-relevant ${result.executionId} facts.`,
      })),
      continuation: {
        findings: [
          "Task-relevant execution-1 facts.",
          "Task-relevant execution-2 facts.",
          "Task-relevant execution-3 facts.",
        ],
        evidenceRefs: ["execution-1", "execution-2", "execution-3"],
      },
    });
    expect(
      firstCompactionInputs.every(({ messages }) =>
        JSON.stringify(messages).includes("Use all source facts."),
      ),
    ).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      "context.compaction.completed",
      expect.objectContaining({
        coveredSourceCount: 3,
        sourceRevision: 9,
      }),
    );

    const nextRequestToolResults: RequestToolResultsView = Object.freeze({
      sourceRevision: 11,
      results: Object.freeze([
        ...requestToolResults.results,
        Object.freeze({
          executionId: "execution-4",
          callId: call.callId,
          invocationAttempt: 4,
          capabilityId: "example.observe",
          declaredEffect: "observation" as const,
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: "Observed source 4.",
          referenceData: "RAW_EVIDENCE_4:".repeat(500),
          references: Object.freeze([
            Object.freeze({
              kind: "tool_target" as const,
              target: "evidence/source-4.md",
            }),
          ]),
        }),
      ]),
    });
    await runWorkerDecision(request, {
      call,
      requestToolResults: nextRequestToolResults,
    });

    const compactionInputs = modelInputs.filter(
      ({ modelStep }) => modelStep === CONTEXT_COMPACTION_MODEL_STEP,
    );
    expect(compactionInputs).toHaveLength(4);
    expect(JSON.stringify(compactionInputs[3]!.messages)).toContain(
      "execution-4",
    );
    expect(JSON.stringify(compactionInputs[3]!.messages)).toContain(
      "Task-relevant execution-1 facts.",
    );
    expect(JSON.stringify(compactionInputs[3]!.messages)).not.toContain(
      "RAW_EVIDENCE_1",
    );
    expect(
      contextCompactionStore.get(`worker:${call.callId}:request-tool-results`),
    ).toMatchObject({
      sourceRevision: 11,
      sourceDigests: nextRequestToolResults.results.map((result) => ({
        sourceRef: result.executionId,
        sourceFingerprint: createSemanticCompactionSha256Fingerprint(
          JSON.stringify(result),
        ),
        digest: `Task-relevant ${result.executionId} facts.`,
      })),
      continuation: {
        findings: [
          "Task-relevant execution-1 facts.",
          "Task-relevant execution-2 facts.",
          "Task-relevant execution-3 facts.",
          "Task-relevant execution-4 facts.",
        ],
      },
    });

    const handoffRequestToolResults: RequestToolResultsView = Object.freeze({
      sourceRevision: 12,
      results: Object.freeze([
        ...nextRequestToolResults.results,
        Object.freeze({
          executionId: "execution-5",
          callId: call.callId,
          invocationAttempt: 5,
          capabilityId: "example.observe",
          declaredEffect: "observation" as const,
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: "Observed source 5.",
          referenceData: "RAW_EVIDENCE_5:".repeat(5),
          references: Object.freeze([
            Object.freeze({
              kind: "tool_target" as const,
              target: "evidence/source-5.md",
            }),
          ]),
        }),
      ]),
    });
    authorResult = true;
    await expect(
      runWorkerDecision(request, {
        call,
        requestToolResults: handoffRequestToolResults,
      }),
    ).resolves.toEqual({
      action: "return_result",
      result: "Compacted evidence handoff.",
    });
    const handoffWorkerInput = modelInputs
      .filter(({ modelStep }) => modelStep === WORKER_DECISION_MODEL_STEP)
      .at(-1);
    expect(JSON.stringify(handoffWorkerInput?.messages)).toContain(
      "RAW_EVIDENCE_5",
    );
    const handoffCompactionInputs = modelInputs.filter(
      ({ modelStep }) => modelStep === CONTEXT_COMPACTION_MODEL_STEP,
    );
    expect(handoffCompactionInputs).toHaveLength(5);
    expect(
      JSON.parse(
        readModelMessages(handoffCompactionInputs.at(-1)!.messages).at(-1)!
          .content,
      ),
    ).toMatchObject({
      newSources: [expect.objectContaining({ sourceRef: "execution-5" })],
    });
    const resultAuthorInputs = modelInputs.filter(
      ({ modelStep }) => modelStep === WORKER_RESULT_MODEL_STEP,
    );
    expect(resultAuthorInputs).toHaveLength(1);
    const resultAuthorMessages = JSON.stringify(
      resultAuthorInputs[0]!.messages,
    );
    expect(resultAuthorMessages).toContain("semanticCheckpoint");
    expect(resultAuthorMessages).toContain("evidence/source-1.md");
    expect(resultAuthorMessages).toContain("Task-relevant execution-1 facts.");
    expect(resultAuthorMessages).toContain("Task-relevant execution-4 facts.");
    expect(resultAuthorMessages).toContain("Task-relevant execution-5 facts.");
    expect(resultAuthorMessages).not.toContain("RAW_EVIDENCE_1");
    expect(resultAuthorMessages).not.toContain("RAW_EVIDENCE_4");
    expect(resultAuthorMessages).not.toContain("RAW_EVIDENCE_5");
    expect(
      contextCompactionStore.get(`worker:${call.callId}:request-tool-results`),
    ).toMatchObject({
      sourceRevision: 12,
      sourceDigests: expect.arrayContaining([
        {
          sourceRef: "execution-5",
          sourceFingerprint: createSemanticCompactionSha256Fingerprint(
            JSON.stringify(handoffRequestToolResults.results.at(-1)!),
          ),
          digest: "Task-relevant execution-5 facts.",
        },
      ]),
      continuation: {
        findings: expect.arrayContaining([
          "Task-relevant execution-1 facts.",
          "Task-relevant execution-4 facts.",
          "Task-relevant execution-5 facts.",
        ]),
      },
    });

    authorResult = false;
    const remediationCall: RoleCallFrame = Object.freeze({
      ...call,
      callId: "call-remediation-worker",
      objective: "Create the missing artifact from the collected evidence.",
    });
    const priorWorkerReceipts = handoffRequestToolResults.results.map(
      (result) => {
        const {
          referenceData: _referenceData,
          adapterResult: _adapterResult,
          ...receipt
        } = result;
        return Object.freeze(receipt);
      },
    );
    const remediationExactResults = [6, 7].map((index) =>
      Object.freeze({
        executionId: `execution-${index}`,
        callId: remediationCall.callId,
        invocationAttempt: index - 5,
        capabilityId: "example.observe",
        declaredEffect: "observation" as const,
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: `Observed source ${index}.`,
        references: Object.freeze([
          Object.freeze({
            kind: "tool_target" as const,
            target: `evidence/source-${index}.md`,
          }),
        ]),
        adapterResult: Object.freeze({
          kind: "registered_tool_execution_result_v1" as const,
          authority: "registered_plugin" as const,
          status: "executed" as const,
          result: Object.freeze({
            ok: true,
            tool: "example.observe",
            output: `RAW_EVIDENCE_${index}:`.repeat(500),
            producedNewInformation: true,
          }),
        }),
      }),
    );
    const remediationRequestToolResults: RequestToolResultsView = Object.freeze(
      {
        sourceRevision: 14,
        results: Object.freeze([
          ...priorWorkerReceipts,
          ...remediationExactResults,
        ]),
      },
    );
    await runWorkerDecision(request, {
      call: remediationCall,
      requestToolResults: remediationRequestToolResults,
    });
    const remediationInput = modelInputs
      .filter(({ modelStep }) => modelStep === WORKER_DECISION_MODEL_STEP)
      .at(-1)!;
    const remediationMessages = JSON.stringify(remediationInput.messages);
    expect(remediationMessages).toContain("semanticCheckpoint");
    expect(remediationMessages).toContain("Observed source 1.");
    expect(remediationMessages).toContain("Task-relevant execution-6 facts.");
    expect(remediationMessages).toContain("Task-relevant execution-7 facts.");
    expect(remediationMessages).not.toContain("RAW_EVIDENCE_1");
    expect(remediationMessages).not.toContain("RAW_EVIDENCE_4");
    expect(remediationMessages).not.toContain("RAW_EVIDENCE_6");
    expect(remediationMessages).not.toContain("RAW_EVIDENCE_7");
    expect(
      modelInputs.filter(
        ({ modelStep }) => modelStep === CONTEXT_COMPACTION_MODEL_STEP,
      ),
    ).toHaveLength(7);
    expect(
      modelInputs
        .filter(({ modelStep }) => modelStep === CONTEXT_COMPACTION_MODEL_STEP)
        .slice(-2)
        .flatMap(({ messages }) => {
          const payload = JSON.parse(
            readModelMessages(messages).at(-1)!.content,
          ) as {
            newSources: readonly { sourceRef: string }[];
          };
          expect(payload.newSources).toHaveLength(1);
          return payload.newSources.map(({ sourceRef }) => sourceRef);
        }),
    ).toEqual(["execution-6", "execution-7"]);
    expect(onEvent).not.toHaveBeenCalledWith(
      "context.compaction.failed",
      expect.anything(),
    );
  });
});
