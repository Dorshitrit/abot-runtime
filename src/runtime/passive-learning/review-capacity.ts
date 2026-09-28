/** The exact review envelope was rejected locally before provider dispatch. */
export class LearningReviewCapacityError extends Error {
  constructor() {
    super("learning_review_context_exceeds_budget");
    this.name = "LearningReviewCapacityError";
  }
}

export function rejectLearningReviewCapacity(error: unknown): never {
  if (isLearningReviewContextCapacityFailure(error)) throw new LearningReviewCapacityError();
  throw error;
}

function isLearningReviewContextCapacityFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "request_context_final_envelope_exceeds_window") return true;
  return error.message === "request_context_required_content_exceeds_budget";
}
