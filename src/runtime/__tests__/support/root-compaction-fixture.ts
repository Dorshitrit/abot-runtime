import {
  semanticCompactionReplacementSlots,
  isSemanticCheckpointMeasurement,
} from "./semantic-compaction-replacement-fixture.js";
import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import type { RequestContextCompactionStore } from "../../context/semantic-compaction/store.js";
import type { RequestTemporalContext } from "../../context/request-temporal-context.js";
import type { LongTermMemoryService } from "../../long-term-memory/contracts.js";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import {
  createRequestSessionMemory,
  createModelSessionMemoryCompactor,
} from "../../context/session-memory/index.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import { createRoleCallLedger } from "../../orchestration/role-calls/index.js";
import {
  EXECUTION_AGENT_V1_EXECUTION_POLICY,
  SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
} from "../../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { runExecutionAgentDecision } from "../../steps/execution-agent/run.js";
import { runExecutionAgentResponse } from "../../steps/execution-agent/response-run.js";
import { runSupervisorDecision } from "../../steps/supervisor-decision/run.js";
import { runSupervisorResponse } from "../../steps/supervisor-response/run.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

import {
  ROOT_REQUEST,
  HISTORY_FACT,
  LATEST_CORRECTION,
  ACTIVE_FACT,
  RECALL_FACT,
  settleRootEvidence,
  settleRootRecall,
} from "./root-compaction-evidence.js";
export {
  ROOT_REQUEST,
  HISTORY_FACT,
  ACTIVE_FACT,
} from "./root-compaction-evidence.js";
export type RootCompactionPolicy =
  | "execution-agent-v1"
  | "supervisor-worker-v1";

let nextRequestSequence = 0;

export async function createRootCompactionFixture(
  policy: RootCompactionPolicy,
  options: Readonly<{
    response?: boolean;
    batch?: boolean;
    recall?: boolean;
    fullChain?: boolean;
    profileId?: string;
    contextWindowTokens?: number;
    baseInputTokens?: number;
    sessionStore?: ReturnType<typeof createInMemorySessionStore>;
    contextCompactionStore?: RequestContextCompactionStore;
    prompt?: string;
    noActiveEvidence?: boolean;
    temporalContext?: RequestTemporalContext;
  }> = {},
) {
  const profileId = options.profileId ?? "compaction-test";
  const contextWindowTokens = options.contextWindowTokens ?? 32000;
  const prompt = options.prompt ?? ROOT_REQUEST;
  const sessionId = `root-compaction-${policy}-session`;
  const requestId = `root-compaction-${policy}-${++nextRequestSequence}`;
  const sessionStore = options.sessionStore ?? createInMemorySessionStore();
  for (let index = 0; !options.sessionStore && index < 12; index++) {
    const previousRequestId = `history-${index}`;
    await sessionStore.appendMessage(
      sessionId,
      "user",
      index < 2
        ? `${HISTORY_FACT} ${"old detail ".repeat(60)}`
        : `Protected request ${index}${index === 11 ? ` ${LATEST_CORRECTION}` : ""}`,
      { requestId: previousRequestId },
    );
    await sessionStore.appendMessage(
      sessionId,
      "assistant",
      `Settled answer ${index}`,
      { requestId: previousRequestId },
    );
  }
  const session = (await sessionStore.getSessionById(sessionId))!;
  const sessionMemory = createRequestSessionMemory({
    sessionId,
    session,
    repository: sessionStore,
    compactor: createModelSessionMemoryCompactor(),
  });
  const executionPolicy =
    policy === "execution-agent-v1"
      ? EXECUTION_AGENT_V1_EXECUTION_POLICY
      : SUPERVISOR_WORKER_V1_EXECUTION_POLICY;
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: executionPolicy.authority,
      limits: {
        maxDepth: 12,
        maxCalls: 48,
        maxCapabilityExecutions: 96,
        maxObjectiveChars: 16000,
        maxResultChars: 64000,
        maxResponseChars: 64000,
      },
    },
  });
  const commit = async (command: unknown) => {
    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    if (!result.ok) throw new Error(result.code);
    return result;
  };
  await commit({ authority: "runtime", type: "create_root" });
  const resume = options.noActiveEvidence
    ? undefined
    : await settleRootEvidence(ledger, {
        executionAgent: policy === "execution-agent-v1",
        ...options,
      });
  const memoryRecallMessage = options.recall
    ? await settleRootRecall(ledger)
    : undefined;
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === "call-1")!;
  const rootRole = policy === "execution-agent-v1" ? "execution" : "supervisor";
  const rootStep: ModelStep = `${rootRole}.${options.response ? "response" : "decision"}`;
  const rootInputs: ChatMessage[][] = [];
  const modelInputs: Array<{ step: string; messages: readonly ChatMessage[] }> =
    [];
  const counts: Array<{
    inputTokens: number;
    messages: readonly ChatMessage[];
  }> = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    modelInputs.push({ step: input.modelStep!, messages });
    if (input.modelStep !== "context.compact") {
      rootInputs.push([...messages]);
      const text = options.response
        ? "The source observation is available."
        : JSON.stringify({ decision: { action: "respond" } });
      return { text, meta: {} };
    }
    const payload = JSON.parse(messages.at(-1)!.content);
    if (payload.kind === "runtime_session_memory_compaction_input_v1")
      return { text: JSON.stringify({ summary: HISTORY_FACT }), meta: {} };
    const sources = payload.newSources as Array<{
      sourceRef: string;
      content: string;
    }>;
    return {
      text: JSON.stringify({
        sourceDigests: semanticCompactionReplacementSlots(
          payload,
          (sourceRef) =>
            sources
              .find((source) => source.sourceRef === sourceRef)
              ?.content.includes(RECALL_FACT)
              ? RECALL_FACT
              : ACTIVE_FACT,
        ),
        continuation: {
          completed: ["Observed source"],
          currentState: ACTIVE_FACT,
          findings: [ACTIVE_FACT],
          evidenceRefs: sources.map(({ sourceRef }) => sourceRef),
          artifacts: [],
          decisions: [],
          failedApproaches: [],
          openWork: [ROOT_REQUEST],
          blockers: [],
          nextStep: "Present the observation.",
        },
      }),
      meta: {},
    };
  });
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    const serialized = JSON.stringify(input.messages);
    const checkpointMeasurement = isSemanticCheckpointMeasurement(
      input.messages,
    );
    const inputTokens = checkpointMeasurement
      ? 1000
      : compactionInputCount(
          input.modelStep,
          serialized,
          options.baseInputTokens,
        );
    if (input.modelStep === rootStep && !checkpointMeasurement)
      counts.push({
        inputTokens,
        messages: input.messages as readonly ChatMessage[],
      });
    return {
      profileId,
      provider: "openai",
      model: "compaction-test-model",
      contextWindowTokens,
      inputTokens,
      source: "provider_input_token_count",
    };
  });
  const events: Array<{ name: string; [key: string]: unknown }> = [];
  const request = createTestRequestExecutionScope({
    requestId,
    sessionId,
    prompt,
    temporalContext: options.temporalContext,
    historyMessages: session.messages,
    sessionMemory,
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    executionPolicySelection: {
      policy,
      primaryProfileId: profileId,
      source: "model_profile",
    },
    runnerConfig: {
      models: { defaults: { profileId, steps: {} } },
      context: {
        outputReserveTokens: 4096,
        safetyReserveTokens: 1200,
        attachmentReserveTokens: 0,
      },
      steps: {
        [rootStep]: { timeoutMs: 20000 },
        "context.compact": { timeoutMs: 20000 },
      },
    },
    modelPolicy: {
      providers: { openai: { type: "openai" } },
      profiles: {
        [profileId]: {
          provider: "openai",
          model: "compaction-test-model",
          contextWindowTokens,
        },
      },
      defaults: { profileId, steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    ...(options.contextCompactionStore
      ? { contextCompactionStore: options.contextCompactionStore }
      : {}),
    ...(options.recall
      ? {
          longTermMemory: {
            enabled: true,
            retrieve: vi.fn(),
            processCandidates: vi.fn(),
            scheduleCandidates: vi.fn(),
            status: vi.fn(),
            list: vi.fn(),
            search: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
          } satisfies LongTermMemoryService,
        }
      : {}),
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
    onEvent: (name, extra) => {
      events.push({ name, ...extra });
    },
  });
  const executionOptions = {
    head,
    call,
    ...(memoryRecallMessage ? { memoryRecallMessage } : {}),
    steeringSnapshot: createRequestSteeringInbox({
      requestId,
    }).snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: true,
    allowAuditor: true,
  };
  const supervisorOptions = {
    call: {
      rootCallId: call.callId,
      callId: call.callId,
      parentCallId: call.parentCallId,
      depth: call.depth,
      invocationAttempt: call.activationCount,
    },
    toolResults: projectRequestToolResults({
      ledger,
      head,
      callId: call.callId,
      modelStep: rootStep,
    }),
    includeAcknowledgement: false,
    includeTitle: false,
    ...(resume ? { resume } : {}),
  };
  const run = () => {
    if (policy === "execution-agent-v1") {
      if (options.response)
        return runExecutionAgentResponse(request, executionOptions);
      return runExecutionAgentDecision(request, executionOptions);
    }
    if (options.response)
      return runSupervisorResponse(request, supervisorOptions);
    return runSupervisorDecision(request, supervisorOptions);
  };
  return {
    run,
    request,
    sessionStore,
    sessionMemory,
    ledger,
    head,
    call,
    rootStep,
    rootInputs,
    modelInputs,
    counts,
    events,
    invoke,
  };
}

function compactionInputCount(
  modelStep: string | undefined,
  serialized: string,
  baseInputTokens = 23814,
) {
  if (modelStep === "context.compact") return 2012;
  if (serialized.includes("runtime_semantic_compaction_checkpoint_v2"))
    return 18000;
  if (serialized.includes("runtime_session_memory_checkpoint_v1")) return 22673;
  return baseInputTokens;
}
