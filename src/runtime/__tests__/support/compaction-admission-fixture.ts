import { vi } from "vitest";

import type {
  ChatMessage,
  ModelGatewayPolicyConfig,
} from "../../../model-gateway/types.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { RequestModelStepInvoker } from "../../model/invoke-step.js";
import type {
  ModelStepCompactionScope,
  ModelStepCompactionStage,
  ModelStepContextCompactionController,
} from "../../model/model-step-port.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { RequestModelInvocationView } from "../../request/contracts.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";

export const ADMISSION_MESSAGES: ChatMessage[] = [
  { role: "system", content: "policy" },
  { role: "user", content: "current request" },
];

export function createAdmissionStage(
  compactionScope: ModelStepCompactionScope,
  label: string,
  commit = vi.fn<() => void | Promise<void>>(),
) {
  const scopeId = `${compactionScope}:test`;
  const prepare = vi.fn<ModelStepCompactionStage["prepare"]>(
    async (messages) => ({
      kind: "prepared",
      preparation: {
        messages: [...messages, { role: "system", content: label }],
        scopeId,
        sourceRevision:
          compactionScope === "session_history" ? "history-revision" : 2,
        coveredSourceCount: compactionScope === "session_history" ? 9 : 5,
        commit,
      },
    }),
  );
  return { compactionScope, scopeId, prepare, commit };
}

export function createAdmissionController(
  stages: readonly ModelStepCompactionStage[],
) {
  const project = vi.fn<ModelStepContextCompactionController["project"]>(
    (messages) => [...messages],
  );
  const getStages = vi.fn(() => stages);
  return { project, getStages };
}

export function createAdmissionFixture(
  options: {
    modelStep?: ModelStep;
    counts?: readonly number[];
    contextWindowTokens?: number;
    onEvent?: (
      name: string,
      extra: Record<string, unknown> | undefined,
    ) => void;
    estimatorOnly?: boolean;
  } = {},
) {
  const modelStep = options.modelStep ?? "supervisor.decision";
  const contextWindowTokens = options.contextWindowTokens ?? 32_000;
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: { provider: { type: "openai" } },
    profiles: {
      test: { provider: "provider", model: "test-model", contextWindowTokens },
    },
    defaults: { profileId: "test", steps: { [modelStep]: modelStep } },
  };
  const abort = new AbortController();
  const steering = createRequestSteeringInbox({
    requestId: "staged-admission",
  });
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: "ok",
    meta: {},
  }));
  const counts = [...(options.counts ?? [23_814, 22_673, 21_000])];
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async () => ({
    inputTokens: counts.shift() ?? 1_000,
    profileId: "test",
    provider: "openai",
    model: "test-model",
    contextWindowTokens,
    source: "provider_input_token_count",
  }));
  const request: RequestModelInvocationView = {
    requestId: "staged-admission",
    runnerConfig: {
      models: {
        defaults: { profileId: "test", steps: { [modelStep]: modelStep } },
      },
      context: {
        outputReserveTokens: 4096,
        safetyReserveTokens: 1200,
        attachmentReserveTokens: 100,
      },
      steps: { [modelStep]: { timeoutMs: 20_000 } },
    },
    agentMode: "reasoning",
    modelPolicy,
    modelGatewayClient: {
      invoke,
      invokeRaw: vi.fn(),
      ...(options.estimatorOnly ? {} : { countInputTokens }),
    },
    requestSteering: steering,
    abortSignal: abort.signal,
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
  };
  const invoker = new RequestModelStepInvoker(request, (name, extra) => {
    events.push([name, extra]);
    options.onEvent?.(name, extra);
  });
  return {
    abort,
    steering,
    events,
    invoke,
    countInputTokens,
    request,
    invoker,
    run: (
      contextCompaction: ModelStepContextCompactionController,
      boundSteeringVersion?: number,
    ) =>
      invoker.invoke({
        modelStep,
        messages: ADMISSION_MESSAGES,
        timeoutReason: "admission_test_timeout",
        contextCompaction,
        ...(boundSteeringVersion === undefined ? {} : { boundSteeringVersion }),
        accept: (text) => text,
      }),
  };
}
