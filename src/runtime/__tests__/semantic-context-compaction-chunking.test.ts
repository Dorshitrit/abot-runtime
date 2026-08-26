import { describe, expect, test, vi } from "vitest";

import type { RequestStepInstructionBlock } from "../config/runner/contracts.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  CONTEXT_COMPACTION_MODEL_STEP,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint,
  generateSemanticCompactionCandidateBatched,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionContinuation,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/index.js";
import {
  createSemanticCompactionSourceSlice,
  projectSemanticCompactionUtf8Boundaries,
} from "../context/semantic-compaction/chunking.js";
import { WORKER_DECISION_MODEL_STEP } from "../steps/worker-decision/index.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

function createContinuation(
  evidenceRefs: readonly string[],
): SemanticCompactionContinuation {
  return Object.freeze({
    completed: Object.freeze(
      evidenceRefs.map((sourceRef) => `Compacted ${sourceRef}.`),
    ),
    currentState: "The batched semantic checkpoint is current.",
    findings: Object.freeze(
      evidenceRefs.map((sourceRef) => `Preserved facts from ${sourceRef}.`),
    ),
    evidenceRefs: Object.freeze([...evidenceRefs]),
    artifacts: Object.freeze([]),
    decisions: Object.freeze([]),
    failedApproaches: Object.freeze([]),
    openWork: Object.freeze(["Continue the active Worker objective."]),
    blockers: Object.freeze([]),
    nextStep: "Resume without rereading compacted sources.",
  });
}

function createSource(
  sourceRef: string,
  content: string,
): SemanticCompactionSource {
  return Object.freeze({
    sourceRef,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}

function createCompactionRequest(
  params: Readonly<{
    requestId: string;
    prompt: string;
    invoke: ModelGatewayClient["invoke"];
    countInputTokens?: ModelGatewayClient["countInputTokens"];
    instructionBlocks?: readonly RequestStepInstructionBlock[];
    store?: ReturnType<typeof createRequestContextCompactionStore>;
    asciiCharactersPerToken?: number;
  }>,
) {
  return createTestRequestExecutionScope({
    requestId: params.requestId,
    sessionId: `${params.requestId}-session`,
    prompt: params.prompt,
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
        [CONTEXT_COMPACTION_MODEL_STEP]: {
          timeoutMs: 20_000,
          ...(params.instructionBlocks
            ? { instructionBlocks: params.instructionBlocks }
            : {}),
        },
      },
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { test: { type: "ollama" } },
      profiles: {
        "compact-test-profile": {
          provider: "test",
          model: "compact-test-model",
          contextWindowTokens: 16_000,
          ...(params.asciiCharactersPerToken
            ? {
                context: {
                  tokenEstimation: {
                    asciiCharactersPerToken: params.asciiCharactersPerToken,
                    nonAsciiBytesPerToken: 2,
                    messageOverheadTokens: 6,
                  },
                },
              }
            : {}),
        },
      },
      defaults: {
        profileId: "compact-test-profile",
        steps: {
          [CONTEXT_COMPACTION_MODEL_STEP]: "compact-test-profile",
        },
      },
    },
    modelGatewayClient: {
      invoke: params.invoke,
      invokeRaw: vi.fn(),
      ...(params.countInputTokens
        ? { countInputTokens: params.countInputTokens }
        : {}),
    },
    ...(params.store ? { contextCompactionStore: params.store } : {}),
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
}

describe("semantic context compaction chunking", () => {
  test("projects contiguous exact UTF-8 ranges without splitting Unicode code points", () => {
    const source = createSource("unicode-source", "A😀אבג\né𐍈Z");
    const boundaries = projectSemanticCompactionUtf8Boundaries(source.content);

    expect(boundaries).toEqual([
      { codeUnitIndex: 0, byteOffset: 0 },
      { codeUnitIndex: 1, byteOffset: 1 },
      { codeUnitIndex: 3, byteOffset: 5 },
      { codeUnitIndex: 4, byteOffset: 7 },
      { codeUnitIndex: 5, byteOffset: 9 },
      { codeUnitIndex: 6, byteOffset: 11 },
      { codeUnitIndex: 7, byteOffset: 12 },
      { codeUnitIndex: 8, byteOffset: 14 },
      { codeUnitIndex: 10, byteOffset: 18 },
      { codeUnitIndex: 11, byteOffset: 19 },
    ]);

    const slices = [
      [0, 2],
      [2, 7],
      [7, 9],
    ].map(([startBoundaryIndex, endBoundaryIndex]) =>
      createSemanticCompactionSourceSlice({
        source,
        boundaries,
        startBoundaryIndex: startBoundaryIndex!,
        endBoundaryIndex: endBoundaryIndex!,
      }),
    );

    expect(slices.map(({ content }) => content).join("")).toBe(source.content);
    expect(slices.map(({ range }) => range)).toEqual([
      { startByte: 0, endByteExclusive: 5, totalBytes: 19 },
      { startByte: 5, endByteExclusive: 14, totalBytes: 19 },
      { startByte: 14, endByteExclusive: 19, totalBytes: 19 },
    ]);
    for (const slice of slices) {
      expect(slice.sourceRef).toBe(source.sourceRef);
      expect(slice.sourceFingerprint).toBe(source.sourceFingerprint);
      expect(slice.sliceFingerprint).toBe(
        createSemanticCompactionSha256Fingerprint(slice.content),
      );
    }
  });

  test("compacts every source that fits in one model call as one batch", async () => {
    const requestId = "multi-source-compaction-batch";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const sources = Object.freeze([
      createSource("source-a", "Exact evidence A with marker A-101."),
      createSource("source-b", "Exact evidence B with marker B-202."),
      createSource("source-c", "Exact evidence C with marker C-303."),
    ]);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const payload = JSON.parse(input.messages.at(-1)!.content) as {
        newSources: readonly { sourceRef: string }[];
      };
      const sourceRefs = payload.newSources.map(({ sourceRef }) => sourceRef);
      expect(sourceRefs).toEqual(["source-a", "source-b", "source-c"]);
      return {
        text: JSON.stringify({
          continuation: createContinuation(sourceRefs),
          sourceDigests: sourceRefs.map(
            (sourceRef) => `Semantic facts for ${sourceRef}.`,
          ),
        }),
        meta: {},
      };
    });
    const request = createCompactionRequest({ requestId, prompt, invoke });
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "batch-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });

    const candidate = await generateSemanticCompactionCandidateBatched({
      request,
      scopeId: "worker:batch-call:request-tool-results",
      binding,
      sourceRevision: 3,
      preservationObjective: objective,
      sources,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
      "source-a",
      "source-b",
      "source-c",
    ]);
  });

  test("uses provider input counts to split a batch that the estimator accepts", async () => {
    const requestId = "provider-counted-compaction-batch";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const sources = Object.freeze([
      createSource("source-a", "Exact evidence A."),
      createSource("source-b", "Exact evidence B."),
      createSource("source-c", "Exact evidence C."),
    ]);
    const invocationBatches: string[][] = [];
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const payload = JSON.parse(input.messages.at(-1)!.content) as {
        previousContinuation?: SemanticCompactionContinuation;
        newSources: readonly { sourceRef: string }[];
      };
      const sourceRefs = payload.newSources.map(({ sourceRef }) => sourceRef);
      invocationBatches.push(sourceRefs);
      const coveredSourceRefs = [
        ...(payload.previousContinuation?.evidenceRefs ?? []),
        ...sourceRefs,
      ];
      return {
        text: JSON.stringify({
          continuation: createContinuation(coveredSourceRefs),
          sourceDigests: sourceRefs.map(
            (sourceRef) => `Semantic facts for ${sourceRef}.`,
          ),
        }),
        meta: {},
      };
    });
    const methodologySentinel = "CONTEXT_COMPACTION_METHODOLOGY_SENTINEL";
    const countedMessageBodies: string[] = [];
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => {
      countedMessageBodies.push(JSON.stringify(input.messages));
      const payload = JSON.parse(
        (input.messages as readonly { content: string }[]).at(-1)!.content,
      ) as { newSources?: readonly unknown[] };
      return {
        inputTokens: payload.newSources?.length === 3 ? 14_000 : 10_000,
        profileId: "compact-test-profile",
        provider: "ollama",
        model: "compact-test-model",
        contextWindowTokens: 16_000,
        source: "provider_input_token_count",
      };
    });
    const request = createCompactionRequest({
      requestId,
      prompt,
      invoke,
      countInputTokens,
      instructionBlocks: [
        {
          ref: "./methodologies/context-compaction.md",
          content: methodologySentinel,
          contentHash: "context-compaction-methodology-hash",
        },
      ],
    });
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "provider-counted-batch-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });

    const candidate = await generateSemanticCompactionCandidateBatched({
      request,
      scopeId: "worker:provider-counted-batch-call:request-tool-results",
      binding,
      sourceRevision: 3,
      preservationObjective: objective,
      sources,
    });

    expect(invocationBatches).toEqual([["source-a", "source-b"], ["source-c"]]);
    expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
      "source-a",
      "source-b",
      "source-c",
    ]);
    expect(countInputTokens).toHaveBeenCalled();
    expect(countedMessageBodies.length).toBeGreaterThan(0);
    expect(
      countedMessageBodies.every(
        (messages) => messages.split(methodologySentinel).length === 2,
      ),
    ).toBe(true);
  });

  test("shrinks a near-ceiling batch to preserve structured repair headroom", async () => {
    const requestId = "repair-safe-compaction-batch";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const sources = Object.freeze([
      createSource("source-a", "Exact evidence A."),
      createSource("source-b", "Exact evidence B."),
      createSource("source-c", "Exact evidence C."),
    ]);
    const invocationBatches: string[][] = [];
    let rejectedFirstBatch = false;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const userMessage = input.messages.find(
        (message) => message.role === "user",
      );
      const payload = JSON.parse(userMessage!.content) as {
        previousContinuation?: SemanticCompactionContinuation;
        newSources: readonly { sourceRef: string }[];
      };
      const sourceRefs = payload.newSources.map(({ sourceRef }) => sourceRef);
      invocationBatches.push(sourceRefs);
      if (!rejectedFirstBatch) {
        rejectedFirstBatch = true;
        return { text: "{}", meta: {} };
      }
      return {
        text: JSON.stringify({
          continuation: createContinuation([
            ...(payload.previousContinuation?.evidenceRefs ?? []),
            ...sourceRefs,
          ]),
          sourceDigests: sourceRefs.map(
            (sourceRef) => `Semantic facts for ${sourceRef}.`,
          ),
        }),
        meta: {},
      };
    });
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => {
      const repairAttempt = input.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("Repair attempt:"),
      );
      const userMessage = input.messages.find(
        (message) => message.role === "user",
      );
      const payload = JSON.parse(userMessage!.content) as {
        newSources?: readonly unknown[];
      };
      let inputTokens = 10_000;
      if (repairAttempt) {
        inputTokens = 10_400;
      } else if (payload.newSources?.length === 3) {
        inputTokens = 13_451;
      }
      return {
        inputTokens,
        profileId: "compact-test-profile",
        provider: "ollama",
        model: "compact-test-model",
        contextWindowTokens: 16_000,
        source: "provider_input_token_count",
      };
    });
    const request = createCompactionRequest({
      requestId,
      prompt,
      invoke,
      countInputTokens,
    });
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "repair-safe-batch-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });

    const candidate = await generateSemanticCompactionCandidateBatched({
      request,
      scopeId: "worker:repair-safe-batch-call:request-tool-results",
      binding,
      sourceRevision: 3,
      preservationObjective: objective,
      sources,
    });

    expect(invocationBatches).toEqual([
      ["source-a", "source-b"],
      ["source-a", "source-b"],
      ["source-c"],
    ]);
    expect(
      countInputTokens.mock.calls.some(([input]) =>
        input.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("Repair attempt:"),
        ),
      ),
    ).toBe(true);
    expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
      "source-a",
      "source-b",
      "source-c",
    ]);
  });

  test("shrinks source slices to preserve structured repair headroom", async () => {
    const requestId = "repair-safe-compaction-slices";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const source = createSource("source-a", "x".repeat(128));
    const invokedSliceContents: string[] = [];
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const payload = JSON.parse(input.messages.at(-1)!.content) as {
        sourceSlice: { sourceRef: string; content: string };
      };
      invokedSliceContents.push(payload.sourceSlice.content);
      return {
        text: JSON.stringify({
          continuation: createContinuation([payload.sourceSlice.sourceRef]),
          sourceDigests: ["Cumulative semantic facts for source-a."],
        }),
        meta: {},
      };
    });
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => {
      const payload = JSON.parse(
        (input.messages as readonly { content: string }[]).at(-1)!.content,
      ) as {
        kind: string;
        sourceSlice?: { content: string };
      };
      const isRepairSafeSlice =
        payload.kind === "runtime_semantic_compaction_slice_input_v1" &&
        (payload.sourceSlice?.content.length ?? 0) <= 64;
      const inputTokens = isRepairSafeSlice ? 10_000 : 13_451;
      return {
        inputTokens,
        profileId: "compact-test-profile",
        provider: "ollama",
        model: "compact-test-model",
        contextWindowTokens: 16_000,
        source: "provider_input_token_count",
      };
    });
    const request = createCompactionRequest({
      requestId,
      prompt,
      invoke,
      countInputTokens,
    });
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "repair-safe-slice-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });

    const candidate = await generateSemanticCompactionCandidateBatched({
      request,
      scopeId: "worker:repair-safe-slice-call:request-tool-results",
      binding,
      sourceRevision: 1,
      preservationObjective: objective,
      sources: Object.freeze([source]),
    });

    expect(invokedSliceContents.join("")).toBe(source.content);
    expect(invokedSliceContents).toHaveLength(2);
    expect(invokedSliceContents.every((content) => content.length <= 64)).toBe(
      true,
    );
    expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
      source.sourceRef,
    ]);
  });

  test("repartitions one uncommitted source slice after output incomplete", async () => {
    const requestId = "output-incomplete-compaction-slice";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const source = createSource("source-a", "x".repeat(128));
    const invokedSlices: Array<{
      content: string;
      range: {
        startByte: number;
        endByteExclusive: number;
        totalBytes: number;
      };
      coveredThroughByte?: number;
    }> = [];
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const payload = JSON.parse(input.messages.at(-1)!.content) as {
        partialSourceFold?: { coveredThroughByte: number };
        sourceSlice: {
          sourceRef: string;
          content: string;
          range: {
            startByte: number;
            endByteExclusive: number;
            totalBytes: number;
          };
        };
      };
      invokedSlices.push({
        content: payload.sourceSlice.content,
        range: payload.sourceSlice.range,
        ...(payload.partialSourceFold
          ? { coveredThroughByte: payload.partialSourceFold.coveredThroughByte }
          : {}),
      });
      if (invokedSlices.length === 1) {
        return {
          text: '{"continuation":',
          meta: {
            providerCompletionReason: "length",
            providerInputTokens: 10_000,
            providerOutputTokens: 4_806,
            providerTotalTokens: 14_806,
          },
        };
      }
      return {
        text: JSON.stringify({
          continuation: createContinuation([payload.sourceSlice.sourceRef]),
          sourceDigests: ["Cumulative semantic facts for source-a."],
        }),
        meta: {},
      };
    });
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => {
      const payload = JSON.parse(
        (input.messages as readonly { content: string }[]).at(-1)!.content,
      ) as { kind: string };
      return {
        inputTokens:
          payload.kind === "runtime_semantic_compaction_slice_input_v1"
            ? 10_000
            : 14_000,
        profileId: "compact-test-profile",
        provider: "ollama",
        model: "compact-test-model",
        contextWindowTokens: 16_000,
        source: "provider_input_token_count",
      };
    });
    const request = createCompactionRequest({
      requestId,
      prompt,
      invoke,
      countInputTokens,
    });
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "output-incomplete-slice-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });

    const candidate = await generateSemanticCompactionCandidateBatched({
      request,
      scopeId: "worker:output-incomplete-slice-call:request-tool-results",
      binding,
      sourceRevision: 1,
      preservationObjective: objective,
      sources: Object.freeze([source]),
    });

    expect(invokedSlices.map(({ content }) => content.length)).toEqual([
      128, 64, 64,
    ]);
    expect(invokedSlices.map(({ range }) => range)).toEqual([
      { startByte: 0, endByteExclusive: 128, totalBytes: 128 },
      { startByte: 0, endByteExclusive: 64, totalBytes: 128 },
      { startByte: 64, endByteExclusive: 128, totalBytes: 128 },
    ]);
    expect(invokedSlices[1]!.coveredThroughByte).toBeUndefined();
    expect(invokedSlices[2]!.coveredThroughByte).toBe(64);
    expect(
      invokedSlices
        .slice(1)
        .map(({ content }) => content)
        .join(""),
    ).toBe(source.content);
    expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
      source.sourceRef,
    ]);
  });

  test("does not repeatedly repartition an incomplete source slice", async () => {
    const requestId = "repeated-output-incomplete-compaction-slice";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const source = createSource("source-a", "x".repeat(128));
    const invokedSliceLengths: number[] = [];
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const payload = JSON.parse(input.messages.at(-1)!.content) as {
        sourceSlice: { content: string };
      };
      invokedSliceLengths.push(payload.sourceSlice.content.length);
      return {
        text: '{"continuation":',
        meta: { providerCompletionReason: "length" },
      };
    });
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => {
      const payload = JSON.parse(
        (input.messages as readonly { content: string }[]).at(-1)!.content,
      ) as { kind: string };
      return {
        inputTokens:
          payload.kind === "runtime_semantic_compaction_slice_input_v1"
            ? 10_000
            : 14_000,
        profileId: "compact-test-profile",
        provider: "ollama",
        model: "compact-test-model",
        contextWindowTokens: 16_000,
        source: "provider_input_token_count",
      };
    });
    const request = createCompactionRequest({
      requestId,
      prompt,
      invoke,
      countInputTokens,
    });
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "repeated-output-incomplete-slice-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });

    await expect(
      generateSemanticCompactionCandidateBatched({
        request,
        scopeId:
          "worker:repeated-output-incomplete-slice-call:request-tool-results",
        binding,
        sourceRevision: 1,
        preservationObjective: objective,
        sources: Object.freeze([source]),
      }),
    ).rejects.toThrow("output_incomplete");
    expect(invokedSliceLengths).toEqual([128, 64]);
  });

  test("keeps the prior checkpoint atomic when a later source batch fails", async () => {
    const requestId = "batched-compaction-atomic";
    const prompt = "Continue from collected evidence.";
    const objective = "Preserve all exact evidence needed for the Worker.";
    const scopeId = "worker:atomic-call:request-tool-results";
    const store = createRequestContextCompactionStore();
    const binding = Object.freeze({
      requestId,
      currentRequestFingerprint:
        createSemanticCompactionSha256Fingerprint(prompt),
      roleId: "worker",
      callId: "atomic-call",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([WORKER_DECISION_MODEL_STEP]),
    });
    const priorSource = createSource("source-prior", "Prior exact evidence.");
    const previous: SemanticCompactionCheckpoint = Object.freeze({
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId,
      ...binding,
      sourceRevision: 1,
      sourceDigests: Object.freeze([
        Object.freeze({
          sourceRef: priorSource.sourceRef,
          sourceFingerprint: priorSource.sourceFingerprint,
          digest: "Prior evidence digest.",
        }),
      ]),
      continuation: createContinuation([priorSource.sourceRef]),
    });
    store.registerSources([priorSource]);
    store.commit(previous);

    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockImplementationOnce(async (input) => {
        const payload = JSON.parse(input.messages.at(-1)!.content) as {
          newSources: readonly { sourceRef: string }[];
        };
        expect(payload.newSources).toHaveLength(1);
        expect(payload.newSources[0]!.sourceRef).toBe("source-a");
        return {
          text: JSON.stringify({
            continuation: createContinuation([
              priorSource.sourceRef,
              "source-a",
            ]),
            sourceDigests: ["Source A digest."],
          }),
          meta: {},
        };
      })
      .mockRejectedValueOnce(new Error("later_source_batch_failed"));
    const request = createCompactionRequest({
      requestId,
      prompt,
      invoke,
      store,
      asciiCharactersPerToken: 1,
    });
    const sources = Object.freeze([
      createSource("source-a", `New exact evidence A:${"a".repeat(7_000)}`),
      createSource("source-b", `New exact evidence B:${"b".repeat(7_000)}`),
    ]);

    await expect(
      generateSemanticCompactionCandidateBatched({
        request,
        scopeId,
        binding,
        sourceRevision: 2,
        preservationObjective: objective,
        previous,
        sources,
      }),
    ).rejects.toThrow("later_source_batch_failed");

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(store.get(scopeId)).toEqual(previous);
    expect(store.get(scopeId)?.sourceDigests).toHaveLength(1);
  });
});
