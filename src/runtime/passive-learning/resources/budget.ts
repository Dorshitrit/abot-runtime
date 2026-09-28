import {
  validateCoWorkerResourceLimits,
  type CoWorkerResourceLimits,
  type CoWorkerResourceReservation,
  type CoWorkerResourceUsage,
} from "./contracts.js";
import { resolveCoWorkerBudgetDay } from "./day-window.js";
import { createCoWorkerResourceStore } from "./store.js";
import { CoWorkerResourceAdmission } from "./admission.js";

function reserveDailyCapacity(
  usage: CoWorkerResourceUsage,
  limits: CoWorkerResourceLimits,
  reservation: CoWorkerResourceReservation,
): CoWorkerResourceUsage {
  if (reservation.kind === "model") {
    if (usage.modelCalls >= limits.modelCallsPerDay)
      throw new Error("co_worker_model_daily_budget_exhausted");
    return { ...usage, modelCalls: usage.modelCalls + 1 };
  }
  const characters = reservation.embeddingCharacters ?? 0;
  if (!Number.isSafeInteger(characters) || characters < 0)
    throw new Error("co_worker_embedding_characters_invalid");
  if (usage.embeddingCalls >= limits.embeddingCallsPerDay)
    throw new Error("co_worker_embedding_daily_budget_exhausted");
  if (characters > limits.embeddingCharactersPerDay - usage.embeddingCharacters)
    throw new Error("co_worker_embedding_character_budget_exhausted");
  return {
    ...usage,
    embeddingCalls: usage.embeddingCalls + 1,
    embeddingCharacters: usage.embeddingCharacters + characters,
  };
}

/** One shared instance per environment; persistent quota is serialized across processes. */
export class CoWorkerResourceBudget {
  private readonly store;
  private readonly admission = new CoWorkerResourceAdmission();

  constructor(
    private readonly options: Readonly<{
      directory: string;
      limits(): CoWorkerResourceLimits;
      now?: () => number;
    }>,
  ) {
    this.store = createCoWorkerResourceStore(options.directory);
  }

  async status(): Promise<
    CoWorkerResourceUsage & Readonly<{ activeCalls: number }>
  > {
    const limits = this.options.limits();
    validateCoWorkerResourceLimits(limits);
    const usage = resolveCoWorkerBudgetDay(
      await this.store.read(),
      this.now(),
      limits.timeZone,
    );
    return { ...usage, activeCalls: this.admission.activeCalls };
  }

  /** Persist the day only for an actual effect, such as a proposal delivery. Status never writes. */
  async ensureCurrentWindow(): Promise<
    CoWorkerResourceUsage & Readonly<{ activeCalls: number }>
  > {
    const usage = await this.store.update((previous) => {
      const limits = this.options.limits();
      validateCoWorkerResourceLimits(limits);
      return resolveCoWorkerBudgetDay(previous, this.now(), limits.timeZone);
    });
    return { ...usage, activeCalls: this.admission.activeCalls };
  }

  async reserve(reservation: CoWorkerResourceReservation): Promise<() => void> {
    reservation.signal.throwIfAborted();
    const limits = this.options.limits();
    validateCoWorkerResourceLimits(limits);
    const release = await this.admission.acquire({
      ...reservation,
      maximum: () => {
        const current = this.options.limits();
        validateCoWorkerResourceLimits(current);
        return current.maxConcurrentCalls;
      },
    });
    try {
      await this.store.update((previous) => {
        reservation.signal.throwIfAborted();
        reservation.assertActivityAllowed();
        const currentLimits = this.options.limits();
        validateCoWorkerResourceLimits(currentLimits);
        return reserveDailyCapacity(
          resolveCoWorkerBudgetDay(
            previous,
            this.now(),
            currentLimits.timeZone,
          ),
          currentLimits,
          reservation,
        );
      });
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
