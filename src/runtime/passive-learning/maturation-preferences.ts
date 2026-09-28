import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { DEFAULT_MATURATION_POLICY, normalizeMaturationPolicy } from "../long-term-memory/maturation/retention.js";
import type { PassiveLearningPreferences } from "./contracts.js";

/** Co-worker keeps a projection for its controls; the memory repository owns policy. */
export async function projectLearningMaturationPreferences(
  memory: LongTermMemoryService,
  preferences: PassiveLearningPreferences,
  initialize = false,
): Promise<PassiveLearningPreferences> {
  const legacy = normalizeMaturationPolicy(preferences.maturation ?? DEFAULT_MATURATION_POLICY);
  const learning = memory.learning;
  if (!learning?.policy || !learning.configurePolicy) return { ...preferences, maturation: legacy };
  try {
    const maturation = initialize
      ? await learning.configurePolicy(legacy, true)
      : await learning.policy();
    return { ...preferences, maturation };
  } catch {
    // Memory outages must not disable the independent collection controls.
    return { ...preferences, maturation: legacy };
  }
}

export async function commitLearningMaturationPreferences(
  memory: LongTermMemoryService,
  preferences: PassiveLearningPreferences,
  requested: Partial<PassiveLearningPreferences>,
  persistence: Readonly<{
    previous: PassiveLearningPreferences;
    persist(preferences: PassiveLearningPreferences): Promise<void>;
  }>,
): Promise<PassiveLearningPreferences> {
  if (!requested.maturation) {
    const projected = await projectLearningMaturationPreferences(memory, preferences);
    await persistence.persist(projected);
    return projected;
  }
  const learning = memory.learning;
  if (!learning?.configurePolicy) throw new Error("learning_memory_unavailable");
  const previous = { ...persistence.previous, maturation: await learning.policy() };
  const next = { ...preferences, maturation: normalizeMaturationPolicy(requested.maturation) };
  // The journal is a projection. Do not publish canonical policy until it is durable.
  await persistence.persist(next);
  try {
    const maturation = await learning.configurePolicy(next.maturation);
    return { ...next, maturation };
  } catch (error) {
    await persistence.persist(previous);
    throw error;
  }
}
