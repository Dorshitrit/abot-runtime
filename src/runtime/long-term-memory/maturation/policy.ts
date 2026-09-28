import type { LongTermMemoryRepository, LongTermMemoryRepositorySnapshot } from "../contracts.js";
import type { MaturationPolicy } from "./contracts.js";
import { DEFAULT_MATURATION_POLICY, normalizeMaturationPolicy } from "./retention.js";

/** The repository is the sole policy owner, including while collection is off. */
export function learningMaturationPolicy(snapshot: LongTermMemoryRepositorySnapshot): MaturationPolicy {
  return normalizeMaturationPolicy(snapshot.maturationPolicy ?? DEFAULT_MATURATION_POLICY);
}

export async function configureLearningMaturationPolicy(
  repository: LongTermMemoryRepository,
  requested: MaturationPolicy,
  initializeOnly = false,
): Promise<MaturationPolicy> {
  const normalized = normalizeMaturationPolicy(requested);
  const committed = await repository.update((current) => {
    const preserveEstablishedPolicy = initializeOnly && current.maturationPolicy !== undefined;
    if (preserveEstablishedPolicy) return current;
    return { ...current, maturationPolicy: normalized };
  });
  return learningMaturationPolicy(committed);
}
