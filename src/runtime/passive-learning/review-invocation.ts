import { LearningDecisionEnvelopeError } from "../long-term-memory/maturation/decision-envelope.js";
import { traceDebug } from "../observability/debug-logger.js";
import { buildLearningReviewMessages } from "./memory-review-format.js";
import { decodeLearningReviewDecisions, LearningReviewOutputError } from "./review-decision-adapter.js";
import { createLearningReviewPresentation, type LearningReviewInput } from "./review-references.js";
import { createLearningReviewFormat } from "./review-response-format.js";
import { learningFailureReason } from "./status-projection.js";

/** One model call; content-free diagnostics follow the same call-local binding snapshot. */
export function createLearningReviewInvocation(input: LearningReviewInput) {
  const presentation = createLearningReviewPresentation(input);
  const { references } = presentation;
  const format = createLearningReviewFormat(references);
  const messages = buildLearningReviewMessages(input, presentation);
  const correlation = { requestId: `learning:${input.batchId}`, batchId: input.batchId,
    modelProfileId: input.modelProfileId, contract: format.name,
    mode: references.scheduled ? "scheduled" : "activity" };
  traceDebug("runtime.passive_learning", "review.prepared", {
    ...correlation, observationCount: references.observationIds.length,
    knowledgeCount: references.knowledge.size, mutableTargetCount: references.targetRefs.length,
    protectedCount: [...references.knowledge.values()].filter(entry => !entry.mutable).length,
    inputCharacters: messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0),
    schemaCharacters: JSON.stringify(format.schema).length,
  });
  return {
    format, messages,
    accept(text: string) {
      try {
        const decisions = decodeLearningReviewDecisions(text, references, format);
        const actionCounts = { create: 0, update: 0, merge: 0, remove: 0 };
        for (const decision of decisions) actionCounts[decision.action]++;
        traceDebug("runtime.passive_learning", "review.output_accepted", {
          ...correlation, outputCharacters: text.length, decisionCount: decisions.length, actionCounts,
        });
        return decisions;
      } catch (error) {
        const details = error instanceof LearningDecisionEnvelopeError ? { stage: "envelope", ...error.shape }
          : error instanceof LearningReviewOutputError ? error.diagnostics : { stage: "decode" };
        traceDebug("runtime.passive_learning", "review.output_rejected", {
          ...correlation, outputCharacters: text.length, reason: learningFailureReason(error), ...details,
        });
        throw error;
      }
    },
  };
}
