import { withSuperCompactionFailure } from "../super-compaction-failure-owner.js";
import type { SemanticCompactionGenerationParams } from "./run.js";

/** SUPER rejects an entire conflicting batch; shared callers retain semantics. */
export function registerSemanticCompactionSources(
  params: SemanticCompactionGenerationParams,
): void {
  const store = params.request.contextCompactionStore;
  if (params.registrationMode !== "atomic") {
    store?.registerSources(params.sources);
    return;
  }
  if (!store?.registerSourcesAtomically)
    throw new Error("context_compaction_atomic_registration_required");
  withSuperCompactionFailure(params.failureOwner, () =>
    store.registerSourcesAtomically!(params.sources),
  );
}
