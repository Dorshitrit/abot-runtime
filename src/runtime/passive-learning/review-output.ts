import { LearningDecisionEnvelopeError } from "../long-term-memory/maturation/decision-envelope.js";
import { parseLearningDecisions } from "../long-term-memory/maturation/decisions.js";
import { traceDebug } from "../observability/debug-logger.js";

/** Preserve rejection without copying passive content into diagnostics or retrying. */
export function parseLearningReviewOutput(text: string, batchId: string) {
  try {
    return parseLearningDecisions(text);
  } catch (error) {
    if (error instanceof LearningDecisionEnvelopeError) {
      traceDebug("runtime.passive_learning", "review.output_rejected", {
        requestId: `learning:${batchId}`, batchId, reason: error.message, ...error.shape,
      });
    }
    throw error;
  }
}
