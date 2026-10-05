import type { ChatMessage } from "../../../model-gateway/types.js";
import type { StagedReviewCall } from "../staged-review-call.js";
import type { ProactiveDecision, ProactiveReviewInput } from "./contracts.js";
import { decodeProactiveModelDecision } from "./model-output.js";
import { authorStagedProactiveProposal } from "./staged-authoring.js";
import { buildStagedProactiveObjectiveMessages,
  buildStagedProactiveTimingMessages, createStagedProactivePresentation } from "./staged-context.js";
import { STAGED_PROACTIVE_SELECTION_FORMAT,
  STAGED_PROACTIVE_OBJECTIVE_FORMAT, createStagedProactiveTimingFormat } from "./staged-format.js";
import { decodeStagedProactiveSources,
  decodeStagedProactiveObjective, decodeStagedProactiveTiming, hasCurrentStagedProactiveTiming } from "./staged-output.js";

/** Each call owns one responsibility; only the final canonical decision may be committed. */
export async function runStagedProactiveReview(
  input: ProactiveReviewInput,
  call: StagedReviewCall,
  referenceMessages: readonly ChatMessage[],
  now: () => number = Date.now,
  emitDiagnostics = true,
): Promise<ProactiveDecision> {
  input.signal.throwIfAborted();
  const presentation = createStagedProactivePresentation(input, referenceMessages);
  const entries = await call("sources", {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "proactive_review_timeout",
    format: STAGED_PROACTIVE_SELECTION_FORMAT, messages: presentation.messages,
    accept: text => decodeStagedProactiveSources(text, presentation.references),
  });
  const objective = entries.length ? await call("objective", {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "proactive_review_timeout",
    format: STAGED_PROACTIVE_OBJECTIVE_FORMAT,
    messages: buildStagedProactiveObjectiveMessages({ reviewId: input.reviewId, sources: entries,
      priorProposals: presentation.priorProposals }),
    accept: decodeStagedProactiveObjective,
  }) : null;
  const authored = objective === null ? null : await authorStagedProactiveProposal({
    reviewId: input.reviewId, objective, sources: entries, styleReference: input.styleReference,
  }, call);
  const timing = await call("timing", {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "proactive_review_timeout",
    format: createStagedProactiveTimingFormat(authored !== null),
    messages: buildStagedProactiveTimingMessages({ reviewId: input.reviewId,
      referenceTime: input.context.referenceTime, sources: entries.length ? entries : input.context.entries, message: authored }),
    accept: (text, diagnostics) => decodeStagedProactiveTiming(text, authored !== null, diagnostics.acceptedAt),
  }, value => hasCurrentStagedProactiveTiming(value, now()));
  input.signal.throwIfAborted();
  const completedInput = { ...input, context: { ...input.context, referenceTime: new Date(now()).toISOString() } };
  return decodeProactiveModelDecision(JSON.stringify({
    kind: authored === null ? "none" : "proposal", title: authored?.title ?? null, message: authored?.message ?? null,
    handoffBrief: authored?.handoffBrief ?? null,
    reason: null, sources: authored === null ? [] : entries.map(({ kind, id, version }) => ({ kind, id, version })),
    ...timing,
  }), completedInput, emitDiagnostics);
}
