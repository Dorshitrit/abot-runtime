import type { PassiveLearningService } from "../passive-learning/contracts.js";
import { readLearningPreferencesInput } from "./learning-preferences-input.js";
import { isLearningEventId } from "./learning-events.js";

/** An explicit management surface excludes collection ingress and lifecycle RPCs. */
export function dispatchLocalLearningCall(
  service: PassiveLearningService | undefined,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  if (!service) throw new Error("passive_learning_unavailable");
  if (method === "learning.status") return service.status();
  if (method === "learning.candidates") {
    if (args.length !== 0)
      throw new Error("passive_learning_candidates_invalid");
    if (!service.candidates) throw new Error("passive_learning_unavailable");
    return service.candidates();
  }
  if (method === "learning.dismissProposal") {
    if (args.length !== 1 || !isLearningEventId(args[0]))
      throw new Error("passive_learning_proposal_invalid");
    if (!service.dismissProposal)
      throw new Error("passive_learning_unavailable");
    return service.dismissProposal(args[0]);
  }
  if (method === "learning.clearPending") {
    if (args.length !== 0)
      throw new Error("passive_learning_clear_pending_invalid");
    return service.clearPending();
  }
  if (method === "learning.restartCollection") {
    if (args.length !== 0)
      throw new Error("passive_learning_restart_collection_invalid");
    if (!service.restartCollection)
      throw new Error("passive_learning_unavailable");
    return service.restartCollection();
  }
  if (method === "learning.configure") {
    if (args.length !== 1)
      throw new Error("passive_learning_preferences_invalid");
    return service.configure(readLearningPreferencesInput(args[0]));
  }
  if (method === "learning.batches") {
    const input = args[0];
    if (input === undefined) return service.batches();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("passive_learning_page_invalid");
    return service.batches(input);
  }
  if (method === "learning.batch") {
    if (typeof args[0] !== "string")
      throw new Error("passive_learning_batch_invalid");
    return service.batch(args[0]);
  }
  throw new Error("local_runtime_method_unknown");
}
