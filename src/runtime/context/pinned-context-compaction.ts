import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../model-gateway/types.js";
import { traceDebug } from "../observability/debug-logger.js";
import type {
  RequestContextBudget,
  RequestContextPinnedPart,
} from "./request-context-contracts.js";
import {
  assessRequestMessagesBudget,
  resolveContextCompactionTriggerInputTokens,
  type RequestMessagesBudgetAssessment,
} from "./request-context-budget.js";
import { estimateMessagesTokens } from "./token-estimator.js";

type RequestContextDiagnostic = Readonly<{
  requestId: string;
  modelStep: string;
  callId?: string;
}>;

type RequestContextEventSink = (
  name: string,
  extra?: Record<string, unknown>,
) => void;

type PinnedPartState = Readonly<{
  part: RequestContextPinnedPart;
  order: number;
  compacted: boolean;
}>;

export type PinnedContextProjection = Readonly<{
  referenceMessages: readonly ChatMessage[];
  continuationMessages: readonly ChatMessage[];
  assessment: RequestMessagesBudgetAssessment;
  compaction: Readonly<{
    applied: boolean;
    compactedSourceRefs: readonly string[];
  }>;
  errorCode?:
    | "request_context_pinned_content_exceeds_budget"
    | "request_context_required_content_exceeds_budget"
    | "request_context_compaction_not_reducing";
}>;

export function projectPinnedContext(params: {
  fixedMessages: readonly ChatMessage[];
  currentMessage: ChatMessage;
  currentMessagePlacement?: "before_continuation" | "after_continuation";
  referenceParts: readonly RequestContextPinnedPart[];
  continuationParts: readonly RequestContextPinnedPart[];
  format?: ModelGatewayJsonSchemaFormat;
  budget: RequestContextBudget;
  diagnostic?: RequestContextDiagnostic;
  onEvent?: RequestContextEventSink;
  /** The outer model-step owns client-visible compaction lifecycle events. */
  deferLifecycleToModelStep?: boolean;
}): PinnedContextProjection {
  const states = validateAndIndexParts([
    ...params.referenceParts,
    ...params.continuationParts,
  ]);
  const fullProjection = assessStates(params, states);
  const triggerInputTokens = resolveContextCompactionTriggerInputTokens(
    params.budget.contextWindowTokens,
  );
  const thresholdCrossed =
    fullProjection.assessment.budget.estimatedInputTokens >=
    triggerInputTokens;

  if (!thresholdCrossed && fullProjection.assessment.fits) {
    return Object.freeze({
      ...fullProjection,
      compaction: NO_COMPACTION,
      ...(!fullProjection.assessment.fits
        ? { errorCode: "request_context_pinned_content_exceeds_budget" as const }
        : {}),
    });
  }

  const candidates = states
    .map((state) => ({
      state,
      savings: estimatePartSavings(state.part, params.budget),
    }))
    .filter(
      (candidate) =>
        candidate.state.part.retention === "compactable" &&
        candidate.savings > 0,
    )
    .sort(
      (left, right) =>
        right.savings - left.savings ||
        left.state.order - right.state.order,
    );
  traceCompaction(params.diagnostic, "triggered", {
    estimatedInputTokens:
      fullProjection.assessment.budget.estimatedInputTokens,
    availableInputTokens:
      fullProjection.assessment.budget.availableInputTokens,
    triggerInputTokens,
    compactablePartCount: candidates.length,
  });

  if (candidates.length === 0) {
    if (fullProjection.assessment.fits) {
      traceCompaction(params.diagnostic, "skipped", {
        reason: "no_compact_variant",
      });
      return Object.freeze({
        ...fullProjection,
        compaction: NO_COMPACTION,
      });
    }
    emitCompactionEvent(params, "context.compaction.failed", {
      phase: "failed",
      reason: "required_content_exceeds_budget",
      beforeInputTokens:
        fullProjection.assessment.budget.estimatedInputTokens,
      availableInputTokens:
        fullProjection.assessment.budget.availableInputTokens,
    });
    traceCompaction(
      params.diagnostic,
      params.deferLifecycleToModelStep ? "deferred" : "rejected",
      {
        reason: "required_content_exceeds_budget",
        compactedPartCount: 0,
      },
    );
    return Object.freeze({
      ...fullProjection,
      compaction: NO_COMPACTION,
      errorCode: "request_context_required_content_exceeds_budget",
    });
  }

  emitCompactionEvent(params, "context.compaction.started", {
    phase: "started",
    beforeInputTokens:
      fullProjection.assessment.budget.estimatedInputTokens,
    triggerInputTokens,
    compactablePartCount: candidates.length,
  });

  let nextStates = states;
  let compactedProjection = fullProjection;
  for (const candidate of candidates) {
    nextStates = nextStates.map((state) =>
      state.order === candidate.state.order
        ? Object.freeze({ ...state, compacted: true })
        : state,
    );
    compactedProjection = assessStates(params, nextStates);
    if (
      compactedProjection.assessment.fits &&
      compactedProjection.assessment.budget.estimatedInputTokens <
        triggerInputTokens
    ) {
      break;
    }
  }

  const compactedSourceRefs = Object.freeze(
    nextStates
      .filter((state) => state.compacted)
      .sort((left, right) => left.order - right.order)
      .map((state) => state.part.sourceRef),
  );
  const compaction = Object.freeze({
    applied: compactedSourceRefs.length > 0,
    compactedSourceRefs,
  });

  if (!compactedProjection.assessment.fits) {
    emitCompactionEvent(params, "context.compaction.failed", {
      phase: "failed",
      reason: "required_content_exceeds_budget",
      beforeInputTokens:
        fullProjection.assessment.budget.estimatedInputTokens,
      afterInputTokens:
        compactedProjection.assessment.budget.estimatedInputTokens,
      availableInputTokens:
        compactedProjection.assessment.budget.availableInputTokens,
      compactedPartCount: compactedSourceRefs.length,
    });
    traceCompaction(
      params.diagnostic,
      params.deferLifecycleToModelStep ? "deferred" : "rejected",
      {
        reason: "required_content_exceeds_budget",
        beforeInputTokens:
          fullProjection.assessment.budget.estimatedInputTokens,
        afterInputTokens:
          compactedProjection.assessment.budget.estimatedInputTokens,
        compactedPartCount: compactedSourceRefs.length,
      },
    );
    return Object.freeze({
      ...compactedProjection,
      compaction,
      errorCode: "request_context_required_content_exceeds_budget",
    });
  }

  if (
    compactedProjection.assessment.budget.estimatedInputTokens >=
    triggerInputTokens
  ) {
    emitCompactionEvent(params, "context.compaction.failed", {
      phase: "failed",
      reason: "compaction_not_reducing",
      beforeInputTokens:
        fullProjection.assessment.budget.estimatedInputTokens,
      afterInputTokens:
        compactedProjection.assessment.budget.estimatedInputTokens,
      triggerInputTokens,
      compactedPartCount: compactedSourceRefs.length,
    });
    traceCompaction(
      params.diagnostic,
      params.deferLifecycleToModelStep ? "deferred" : "rejected",
      {
        reason: "compaction_not_reducing",
        beforeInputTokens:
          fullProjection.assessment.budget.estimatedInputTokens,
        afterInputTokens:
          compactedProjection.assessment.budget.estimatedInputTokens,
        compactedPartCount: compactedSourceRefs.length,
      },
    );
    return Object.freeze({
      ...compactedProjection,
      compaction,
      errorCode: "request_context_compaction_not_reducing",
    });
  }

  emitCompactionEvent(params, "context.compaction.completed", {
    phase: "completed",
    beforeInputTokens:
      fullProjection.assessment.budget.estimatedInputTokens,
    afterInputTokens:
      compactedProjection.assessment.budget.estimatedInputTokens,
    triggerInputTokens,
    compactedPartCount: compactedSourceRefs.length,
  });
  traceCompaction(params.diagnostic, "completed", {
    beforeInputTokens:
      fullProjection.assessment.budget.estimatedInputTokens,
    afterInputTokens:
      compactedProjection.assessment.budget.estimatedInputTokens,
    triggerInputTokens,
    compactedPartCount: compactedSourceRefs.length,
    compactedSourceRefs,
  });
  return Object.freeze({
    ...compactedProjection,
    compaction,
  });
}

const NO_COMPACTION = Object.freeze({
  applied: false,
  compactedSourceRefs: Object.freeze([]) as readonly string[],
});

function validateAndIndexParts(
  parts: readonly RequestContextPinnedPart[],
): readonly PinnedPartState[] {
  const sourceRefs = new Set<string>();
  return Object.freeze(
    parts.map((part, order) => {
      if (!part.sourceRef.trim() || sourceRefs.has(part.sourceRef)) {
        throw new Error("request_context_pinned_part_source_invalid");
      }
      sourceRefs.add(part.sourceRef);
      if (part.messages.length === 0) {
        throw new Error("request_context_pinned_part_messages_required");
      }
      if (
        part.retention === "compactable" &&
        (!part.compactMessages || part.compactMessages.length === 0)
      ) {
        throw new Error("request_context_compact_projection_required");
      }
      return Object.freeze({ part, order, compacted: false });
    }),
  );
}

function assessStates(
  params: Parameters<typeof projectPinnedContext>[0],
  states: readonly PinnedPartState[],
): Omit<PinnedContextProjection, "compaction" | "errorCode"> {
  const referenceMessages = flattenPartMessages(states, "request_reference");
  const continuationMessages = flattenPartMessages(states, "role_continuation");
  const assessment = assessRequestMessagesBudget({
    messages:
      params.currentMessagePlacement === "after_continuation"
        ? [
            ...params.fixedMessages,
            ...referenceMessages,
            ...continuationMessages,
            params.currentMessage,
          ]
        : [
            ...params.fixedMessages,
            ...referenceMessages,
            params.currentMessage,
            ...continuationMessages,
          ],
    ...(params.format ? { format: params.format } : {}),
    budget: params.budget,
  });
  return Object.freeze({
    referenceMessages,
    continuationMessages,
    assessment,
  });
}

function flattenPartMessages(
  states: readonly PinnedPartState[],
  category: RequestContextPinnedPart["category"],
): readonly ChatMessage[] {
  return Object.freeze(
    states
      .filter((state) => state.part.category === category)
      .sort((left, right) => left.order - right.order)
      .flatMap((state) =>
        state.compacted
          ? [...(state.part.compactMessages ?? state.part.messages)]
          : [...state.part.messages],
      ),
  );
}

function estimatePartSavings(
  part: RequestContextPinnedPart,
  budget: RequestContextBudget,
): number {
  if (part.retention !== "compactable" || !part.compactMessages) {
    return 0;
  }
  return (
    estimateMessagesTokens(part.messages, budget.tokenEstimation) -
    estimateMessagesTokens(part.compactMessages, budget.tokenEstimation)
  );
}

function emitCompactionEvent(
  params: Pick<
    Parameters<typeof projectPinnedContext>[0],
    "deferLifecycleToModelStep" | "diagnostic" | "onEvent"
  >,
  name: string,
  extra: Record<string, unknown>,
): void {
  if (params.deferLifecycleToModelStep) {
    return;
  }
  params.onEvent?.(name, {
    stage: "context_compaction",
    ...(params.diagnostic?.modelStep
      ? { modelStep: params.diagnostic.modelStep }
      : {}),
    ...extra,
  });
}

function traceCompaction(
  diagnostic: RequestContextDiagnostic | undefined,
  phase: "triggered" | "completed" | "deferred" | "rejected" | "skipped",
  extra: Record<string, unknown>,
): void {
  if (!diagnostic) {
    return;
  }
  traceDebug("runtime.context", `compaction.${phase}`, {
    ...diagnostic,
    phase: "request_projection",
    ...extra,
  });
}
