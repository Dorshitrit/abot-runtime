import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { buildOpenAIResponsesPayload } from "../../../model-gateway/providers/openai/payload.js";
import type { ModelGatewayClient } from "../../ports.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionContinuation,
  type SemanticCompactionGenerationParams,
} from "../../context/semantic-compaction/index.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { semanticCompactionReplacementSlots } from "./semantic-compaction-replacement-fixture.js";

export const COMPACTION_FACT =
  "target=report.txt; observed=failed; expected=ready";
export const CONFIGURED_COMPACTION_GUIDANCE = "configured-compaction-guidance";
export const CALIBRATED_COMPACTION_GUIDANCE = "calibrated-compaction-guidance";

export function compactContinuation(
  overrides: Partial<SemanticCompactionContinuation> = {},
): SemanticCompactionContinuation {
  return {
    completed: [],
    currentState: COMPACTION_FACT,
    findings: [],
    evidenceRefs: [],
    artifacts: [],
    decisions: [],
    failedApproaches: [],
    openWork: [],
    blockers: [],
    nextStep: "Verify the target.",
    ...overrides,
  };
}

export function readCompactionEnvelope(messages: readonly ChatMessage[]) {
  const sourceMessage = messages.find(({ content }) => {
    try {
      return String(JSON.parse(content).kind).startsWith(
        "runtime_semantic_compaction_",
      );
    } catch {
      return false;
    }
  });
  if (!sourceMessage) throw new Error("compaction_test_envelope_missing");
  return JSON.parse(sourceMessage.content) as {
    kind: string;
    newSources?: readonly {
      sourceKey: string;
      sourceRef: string;
      content: string;
    }[];
    sourceSlice?: {
      sourceKey: string;
      sourceRef: string;
      content: string;
      range: { endByteExclusive: number; totalBytes: number };
    };
    previousContinuation?: SemanticCompactionContinuation;
    previousSourceDigests?: readonly {
      sourceKey: string;
      sourceRef: string;
      digest: string;
    }[];
    partialSourceFold?: unknown;
  };
}

export function semanticContractFixture(
  options: {
    policy?: "execution-agent-v1" | "supervisor-worker-v1";
    sliced?: boolean;
    maxSourcesPerBatch?: number;
    contextWindowTokens?: number;
    output?: (attempt: number, messages: readonly ChatMessage[]) => string;
  } = {},
) {
  const policy = options.policy ?? "supervisor-worker-v1";
  const prompt =
    "Verify the exact target and preserve the observed contradiction.";
  const requestId = `contract-${policy}`;
  const profileId = "contract-model";
  const contextWindowTokens = options.contextWindowTokens ?? 16000;
  const source = {
    sourceRef: "source-contract",
    content: `${COMPACTION_FACT}\n${"evidence detail ".repeat(options.sliced ? 1600 : 10)}`,
  };
  const sourceWithHash = { ...source, sourceFingerprint: hash(source.content) };
  const captured: ChatMessage[][] = [];
  const counted: ChatMessage[][] = [];
  const providerPayloads: Record<string, unknown>[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const messages = input.messages as ChatMessage[];
    captured.push(messages);
    providerPayloads.push(buildOpenAIResponsesPayload(input));
    const envelope = readCompactionEnvelope(messages);
    const refs = envelope.sourceSlice
      ? [envelope.sourceSlice.sourceRef]
      : envelope.newSources!.map(({ sourceRef }) => sourceRef);
    return {
      text:
        options.output?.(captured.length, messages) ??
        JSON.stringify({
          continuation: compactContinuation({ evidenceRefs: refs }),
          sourceDigests: semanticCompactionReplacementSlots(
            envelope,
            () => COMPACTION_FACT,
          ),
        }),
      meta: {},
    };
  });
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    const messages = input.messages as ChatMessage[];
    counted.push(messages);
    const envelope = readCompactionEnvelope(messages);
    return {
      inputTokens:
        requiresSmallerSourceSlice(options.sliced, envelope) ||
        (options.maxSourcesPerBatch !== undefined &&
          (envelope.newSources?.length ?? 0) > options.maxSourcesPerBatch)
          ? 14000
          : 1000,
      profileId,
      provider: "openai",
      model: "contract-test",
      contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const store = createRequestContextCompactionStore();
  const request = createTestRequestExecutionScope({
    requestId,
    sessionId: `${requestId}-session`,
    prompt,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    executionPolicySelection: {
      policy,
      primaryProfileId: profileId,
      source: "model_profile",
    },
    runnerConfig: {
      models: {
        defaults: {
          profileId,
          steps: { "context.compact": "context.compact" },
        },
      },
      context: {
        outputReserveTokens: 2048,
        safetyReserveTokens: 500,
        attachmentReserveTokens: 100,
      },
      steps: {
        "context.compact": {
          timeoutMs: 20000,
          instructionBlocks: [
            {
              ref: "contract.md",
              content: CONFIGURED_COMPACTION_GUIDANCE,
              contentHash: hash(CONFIGURED_COMPACTION_GUIDANCE),
            },
          ],
        },
      },
    },
    modelPolicy: {
      providers: { test: { type: "openai" } },
      profiles: {
        [profileId]: {
          provider: "test",
          model: "contract-test",
          contextWindowTokens,
          calibration: {
            "context.compact": {
              instructions: [CALIBRATED_COMPACTION_GUIDANCE],
            },
          },
        },
      },
      defaults: { profileId, steps: { "context.compact": "context.compact" } },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    contextCompactionStore: store,
    abortSignal: new AbortController().signal,
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  const params: SemanticCompactionGenerationParams = {
    request,
    scopeId: `${policy}:contract`,
    sourceRevision: 1,
    preservationObjective: prompt,
    sources: [sourceWithHash],
    binding: {
      requestId,
      currentRequestFingerprint: hash(prompt),
      roleId: policy === "execution-agent-v1" ? "root" : "worker",
      callId: "contract-call",
      objectiveFingerprint: hash(prompt),
      contextLane: "role_continuation",
      allowedConsumers: [
        policy === "execution-agent-v1"
          ? "execution.decision"
          : "worker.decision",
      ],
    },
  };
  return {
    params,
    source: sourceWithHash,
    store,
    invoke,
    captured,
    counted,
    countInputTokens,
    providerPayloads,
  };
}

function requiresSmallerSourceSlice(
  sliced: boolean | undefined,
  envelope: ReturnType<typeof readCompactionEnvelope>,
): boolean {
  if (!sliced || envelope.kind === "runtime_semantic_compaction_checkpoint_v2")
    return false;
  if (!envelope.sourceSlice) return true;
  return envelope.sourceSlice.content.length > 12000;
}
