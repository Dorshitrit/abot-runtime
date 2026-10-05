import type { RegisteredToolEffectPersistence } from "../adapters/registered-tool-normal-invocations/shared/contracts.js";
import type { AutomationToolLifetimes } from "./tool-lifetimes.js";

/** Holds only the admitted effect boundary, never the surrounding model request. */
export function retainAutomationEffectAdmission(input: {
  runId: string;
  signal: AbortSignal;
  lifetimes: AutomationToolLifetimes;
  persistence: RegisteredToolEffectPersistence;
}): RegisteredToolEffectPersistence {
  const releases = new Map<string, () => void>();
  const releaseAdmission = (executionId: string) => {
    releases.get(executionId)?.();
    releases.delete(executionId);
  };
  return {
    async beforeEffect(effect) {
      if (releases.has(effect.executionId)) throw new Error("automation_attempt_duplicate");
      const release = input.lifetimes.holdEffectAdmission(input.runId, input.signal);
      releases.set(effect.executionId, release);
      try {
        return await input.persistence.beforeEffect(effect);
      } catch (error) {
        releaseAdmission(effect.executionId);
        throw error;
      }
    },
    async afterEffect(effect) {
      try {
        await input.persistence.afterEffect(effect);
      } finally {
        releaseAdmission(effect.executionId);
      }
    },
  };
}
