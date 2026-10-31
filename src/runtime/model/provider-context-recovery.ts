import type { ChatMessage } from "../../model-gateway/types.js";
import { isProviderContextOverflowError } from "../../model-gateway/protocol/provider-context-overflow.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { RequestModelInvocationView } from "../request/contracts.js";
import { resolveRequestBudgetInputTokens, type RequestMessagesBudgetAssessment } from "../context/request-context-budget.js";
import { admitCompactedContext } from "./context-compaction-admission.js";
import type { ModelStepContextCompactionController } from "./context-compaction-contracts.js";
import type { ContextCompactionIdentity } from "./context-compaction-diagnostics.js";
import { createModelContextAssessment } from "./model-context-assessment.js";
import type { ResolvedModelContextAdmission } from "./model-context-budget.js";
import type { ModelStepInvocationInput } from "./model-step-port.js";
import { awaitModelStepWork } from "./model-step-acceptance.js";

/** One extra provider call for a logical step; steering cannot replenish this allowance. */
export class ProviderContextRecovery {
  private attempted = false;

  async invoke<T>(input: Readonly<{
    messages: ChatMessage[];
    invoke(messages: ChatMessage[]): Promise<T>;
    recover?: (signal: AbortSignal) => Promise<ChatMessage[]>;
    signal: AbortSignal;
    identity: Readonly<{ requestId: string; modelStep: string; invocationId: string }>;
  }>): Promise<T> {
    input.signal.throwIfAborted();
    try {
      return await input.invoke(input.messages);
    } catch (error) {
      input.signal.throwIfAborted();
      if (!this.canRecover(error, input.recover)) throw error;
      this.attempted = true;
      traceDebug("runtime.model", "context_overflow.recovery_started", input.identity);
      const messages = await awaitModelStepWork(() => input.recover!(input.signal), input.signal);
      input.signal.throwIfAborted();
      traceDebug("runtime.model", "context_overflow.retry", input.identity);
      // Deliberately outside another recovery catch: a second overflow is terminal.
      return input.invoke(messages);
    }
  }

  private canRecover(error: unknown, recover: unknown): boolean {
    if (this.attempted) return false;
    if (typeof recover !== "function") return false;
    return isProviderContextOverflowError(error);
  }
}

/** Rebuild and readmit the whole consumer envelope before any decision is accepted. */
export function createProviderContextRecoveryPreparation(input: Readonly<{
  request: RequestModelInvocationView;
  params: ModelStepInvocationInput<unknown>;
  admission: ResolvedModelContextAdmission;
  messages: readonly ChatMessage[];
  assessment: RequestMessagesBudgetAssessment;
  controller: ModelStepContextCompactionController;
  assertCurrent(): void;
  identity: ContextCompactionIdentity;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>): (signal: AbortSignal) => Promise<ChatMessage[]> {
  return async (signal) => {
    const assertCurrent = () => {
      signal.throwIfAborted();
      input.assertCurrent();
    };
    assertCurrent();
    const rejectedInputTokens = resolveRequestBudgetInputTokens(input.assessment.budget);
    const targetInputTokens = Math.max(0, Math.min(
      Math.floor(rejectedInputTokens * 0.75),
      input.assessment.budget.availableInputTokens,
      input.assessment.budget.compactionTriggerInputTokens - 1,
    ));
    const originalMessages = JSON.stringify(input.messages);
    const originalMeasured = input.assessment.budget.measuredInputTokens !== undefined;
    const measurement = createModelContextAssessment({
      request: input.request, params: input.params, admission: input.admission,
      assertCurrent, abortSignal: signal,
    });
    const admitted = await admitCompactedContext({
      messages: input.messages, assessment: input.assessment, controller: input.controller,
      assess: async (messages) => {
        assertCurrent();
        if (JSON.stringify(messages) === originalMessages) return input.assessment;
        const candidate = await measurement.assess(messages);
        if ((candidate.budget.measuredInputTokens !== undefined) !== originalMeasured)
          throw new Error("context_compaction_recovery_measurement_changed");
        return candidate;
      },
      assertCurrent, assertNotAborted: assertCurrent, abortSignal: signal,
      identity: input.identity, onEvent: input.onEvent,
      providerOverflowRepair: {
        reason: "provider_context_overflow", originalInputTokens: rejectedInputTokens,
        candidateInputTokens: rejectedInputTokens, targetInputTokens,
      },
    });
    assertCurrent();
    return measurement.projectMedia(admitted.messages);
  };
}
