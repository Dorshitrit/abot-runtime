import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestModelInvocationView } from "../request/contracts.js";
import type { RequestSteeringSnapshot } from "../request/request-steering.js";
import { createModelStepAbort } from "../steps/model-step-timeout.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { ModelStepInvocationInput, ModelStepOutputDiagnostics } from "./model-step-port.js";
import type { ModelStepTimeoutIdentity } from "./model-step-timeout-event.js";
import { invokeModelProvider } from "./provider-failure.js";
import { projectPromptCacheBoundary } from "./prompt-cache-boundary.js";
import { ProviderContextRecovery } from "./provider-context-recovery.js";

type ModelStepAttemptConstructor<T> = Readonly<{
  request: RequestModelInvocationView;
  params: ModelStepInvocationInput<T>;
  messages: ChatMessage[];
  steeringSnapshot: RequestSteeringSnapshot;
  identity: ModelStepTimeoutIdentity;
  stepAbort: ReturnType<typeof createModelStepAbort>;
  onThinking: (delta: string) => void;
  contextRecovery: ProviderContextRecovery;
  recoverContext?: (signal: AbortSignal) => Promise<ChatMessage[]>;
  onContextEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>;

/** Owns one provider attempt and its disposable child abort scope. */
export class ModelStepAttempt {
  readonly steeringSnapshot: RequestSteeringSnapshot;
  readonly identity: ModelStepTimeoutIdentity;

  constructor(private readonly input: ModelStepAttemptConstructor<unknown>) {
    this.steeringSnapshot = input.steeringSnapshot;
    this.identity = input.identity;
  }

  get signal(): AbortSignal {
    return this.input.stepAbort.signal;
  }

  invokeProvider() {
    const { request, params } = this.input;
    return this.input.contextRecovery.invoke({
      messages: this.input.messages, signal: this.signal, recover: this.input.recoverContext,
      identity: { requestId: request.requestId, modelStep: params.modelStep, invocationId: this.identity.invocationId },
      invoke: (messages) => invokeModelProvider(params.modelStep, () =>
      request.modelGatewayClient.invoke({
        messages,
        ...projectPromptCacheBoundary({ messages, beforeMessage: params.promptCacheBoundaryBeforeMessage }),
        agentMode: request.agentMode,
        modelStep: params.modelStep,
        ...(request.reasoningPreference ? { reasoningPreference: request.reasoningPreference } : {}),
      ...(request.modelPreference
          ? { modelPreference: request.modelPreference }
          : {}),
        ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
        abortSignal: this.input.stepAbort.signal,
        debugRequestId: request.requestId,
        ...(params.format === undefined ? {} : { format: params.format }),
        onThinking: this.input.onThinking,
      }),
      ),
    });
  }

  recordOutputReceived(outputDiagnostics: ModelStepOutputDiagnostics): void {
    traceDebug("runtime.model", "step.output_received", {
      requestId: this.input.request.requestId,
      modelStep: this.input.params.modelStep,
      steeringVersion: this.steeringSnapshot.version,
      ...outputDiagnostics,
    });
    if (
      outputDiagnostics.providerInputTokens !== undefined ||
      outputDiagnostics.providerOutputTokens !== undefined ||
      outputDiagnostics.providerTotalTokens !== undefined
    ) {
      this.input.onContextEvent?.("context.window.provider_usage", {
        stage: "context_window",
        phase: "provider_completed",
        requestId: this.input.request.requestId,
        invocationId: this.identity.invocationId,
        modelStep: this.input.params.modelStep,
        profileId: this.identity.profileId,
        measurement: "actual",
        source: "provider_reported",
        ...(outputDiagnostics.providerInputTokens !== undefined
          ? { inputTokens: outputDiagnostics.providerInputTokens }
          : {}),
        ...(outputDiagnostics.providerOutputTokens !== undefined
          ? { outputTokens: outputDiagnostics.providerOutputTokens }
          : {}),
        ...(outputDiagnostics.providerTotalTokens !== undefined
          ? { totalTokens: outputDiagnostics.providerTotalTokens }
          : {}),
      });
    }
  }

  dispose(): void {
    this.input.stepAbort.dispose();
  }
}
