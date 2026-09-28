import { randomUUID } from "node:crypto";
import { projectLearningMaturationPreferences, commitLearningMaturationPreferences } from "./maturation-preferences.js";
import type { LearningBackgroundContext, LearningBackgroundDependencies } from "./background-dependencies.js";
import type {
  HostObservationEvent,
  PassiveCollectionState,
} from "../../shared/passive-observation.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type {
  LearningBatch,
  LearningBatchSummary,
  LearningChangedEvent,
  PassiveLearningConnection,
  PassiveLearningModel,
  PassiveLearningPreferences,
  PassiveLearningService,
  PassiveLearningStatus,
} from "./contracts.js";
import { isWithinAnalysisWindow } from "./analysis-schedule.js";
import {
  canRestartPermissionBlockedCollection,
  hasAnalysisScheduleChanged,
  hasLearningMemoryWriter,
  requiresCollectionConnection,
  requiresLearningAvailability,
} from "./control-policy.js";
import { LearningAnalysisClock } from "./analysis-clock.js";
import { LearningCollectionSource } from "./collection-source.js";
import { CollectionWindowClock } from "./collection-window-clock.js";
import { LearningActiveBatches } from "./active-batches.js";
import { buildLearningServiceStatus } from "./service-status.js";
import { readLearningBatchReceipt } from "./batch-receipt.js";
import { LearningProcessingCycle } from "./processing-cycle.js";
import { LearningBackgroundLifecycle } from "./background-lifecycle.js";
import { validateLearningActivityModels } from "./activity-permissions.js";
import { createPendingLearningBatch } from "./batch-lifecycle.js";
import { LearningJournal } from "./journal.js";
import { ObservationQueue } from "./queue.js";
import { canProcessLearningObservation, isLearningApplicationExcluded } from "./application-policy.js";
import { commitLearningApplicationPreferences } from "./application-controls.js";
import {
  learningFailureReason,
  summarizeBatch,
} from "./status-projection.js";
import {
  DEFAULT_LEARNING_PREFERENCES,
  normalizeLearningPreferences,
} from "./store.js";

export type PassiveLearningServiceOptions = Readonly<{
  directory: string;
  ownerId: string;
  memory: LongTermMemoryService;
  model: PassiveLearningModel;
  backgroundDependencies?(context: LearningBackgroundContext): LearningBackgroundDependencies;
  connect?: PassiveLearningConnection;
  now?: () => number;
  /** Test clock override; production cadence belongs to feature preferences. */
  batchDelayMs?: number;
  isInteractiveBusy?: () => boolean;
}>;

export function createPassiveLearningService(
  options: PassiveLearningServiceOptions,
): PassiveLearningService {
  const service = new LearningService(options);
  return Object.freeze({
    start: () => service.start(),
    stop: () => service.stop(),
    configure: (input) => service.configure(input),
    status: () => service.status(),
    clearPending: () => service.clearPending(),
    restartCollection: () => service.restartCollection(),
    batches: (input) => service.batches(input),
    batch: (id) => service.batch(id),
    accept: (event) => service.accept(event),
    flush: () => service.flush(),
    beginInteractive: () => service.beginInteractive(),
    subscribe: (listener) => service.subscribe(listener),
    dismissProposal: (id) => service.dismissProposal(id),
    sessionDeleted: (id) => service.sessionDeleted(id),
    notifyKnowledgeChanged: () => service.notifyKnowledgeChanged(),
    candidates: () => service.candidates(),
  });
}

class LearningService {
  private readonly background: LearningBackgroundDependencies;
  private readonly journal;
  private readonly queue = new ObservationQueue((item) => canProcessLearningObservation(item, this.preferences));
  private preferences = DEFAULT_LEARNING_PREFERENCES;
  private state: "off" | PassiveCollectionState = "off";
  private reason: string | undefined;
  private processingReason: string | undefined;
  private processingUnavailable = false;
  private generation = randomUUID();
  private deviceId: string | undefined;
  private lastObservationAt: string | undefined;
  private started = false;
  private initialized = false;
  private closing = false;
  private changingApplications = false;
  private interactive = 0;
  private readonly source: LearningCollectionSource;
  private readonly collectionClock: CollectionWindowClock;
  private readonly clock: LearningAnalysisClock;
  private readonly active = new LearningActiveBatches();
  private readonly processingCycle: LearningProcessingCycle;
  private readonly backgroundLifecycle: LearningBackgroundLifecycle;
  private controls: Promise<unknown> = Promise.resolve();
  private readonly sequences = new Map<string, number>();
  private readonly listeners = new Set<(event?: LearningChangedEvent) => void>();

  constructor(private readonly options: PassiveLearningServiceOptions) {
    this.background = options.backgroundDependencies?.({
      preferences: () => this.preferences,
      changed: (event) => this.changed(event),
      isInteractiveBusy: () => this.isInteractiveBusy(),
      isStarted: () => this.started,
      isProcessingBusy: () => this.processingUnavailable || this.active.size > 0 || this.processingCycle.hasReadyWork(),
      assertProcessingAllowed: () => {
        if (!this.canProcess()) throw new Error("learning_processing_paused");
        if (!isWithinAnalysisWindow(this.now(), this.preferences.analysisWindow)) throw new Error("learning_outside_processing_window");
      },
    }) ?? { memory: options.memory, model: options.model };
    this.clock = new LearningAnalysisClock(() => {
      void this.flush().catch((error) => this.failProcessing(error));
    }, () => this.now());
    this.backgroundLifecycle = new LearningBackgroundLifecycle({ background: this.background,
      changed: () => this.changed() });
    this.source = new LearningCollectionSource({
      ownerId: options.ownerId,
      connect: options.connect,
      enabled: () => this.canCollect(),
      excludedApplications: () => this.preferences.excludedApplications,
      opening: () => {
        this.sequences.clear();
        this.state = "starting";
        this.reason = undefined;
        this.changed();
      },
      event: (event) => this.accept(event),
      failed: (error) => this.failFeature(error),
    });
    this.collectionClock = new CollectionWindowClock({
      enabled: () => this.started && this.preferences.enabled,
      window: () => this.preferences.collectionWindow,
      now: () => this.now(), open: () => this.source.open(),
      close: () => {
        this.source.close(); this.state = "off"; this.deviceId = undefined;
        this.reason = this.preferences.enabled ? "learning_outside_collection_window" : undefined;
        this.changed();
      },
      boundary: () => { void this.collectionClock.synchronize().catch((error) => this.failFeature(error)); },
    });
    this.journal = new LearningJournal({
      directory: options.directory,
      now: () => this.now(),
      preferences: () => this.preferences,
      changed: () => {
        this.changed();
        this.arm();
      },
      failed: (error) => this.failProcessing(error),
      receipt: (batchId) => readLearningBatchReceipt(this.background.memory, batchId),
    });
    this.processingCycle = new LearningProcessingCycle({
      background: this.background, queue: this.queue, journal: this.journal, active: this.active, clock: this.clock,
      preferences: () => this.preferences, canProcess: () => this.canProcess(), generation: () => this.generation,
      canReconcileReceipts: () => this.canReconcileReceipts(),
      now: () => this.now(), intervalMs: () => this.intervalMs(), concurrency: () => this.effectiveConcurrency(),
      dispatch: (batch) => this.dispatch(batch), arm: () => this.arm(),
      deferred: () => { this.processingReason = undefined; this.changed(); },
    });
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  start(): Promise<void> {
    return this.control(async () => {
      if (this.started) return;
      this.started = true;
      try {
        await this.initialize();
        await this.journal.start();
        this.queue.startExpiry({
          now: () => this.now(),
          changed: () => { this.changed(); this.arm(); },
        });
        const shouldValidateAnalysisOnStart =
          this.preferences.modelProfileId && !this.preferences.processingPaused;
        this.processingUnavailable = false;
        if (shouldValidateAnalysisOnStart) {
          await this.requireAvailable(this.preferences).then(() => { this.processingReason = undefined; }).catch((error) => {
            this.processingUnavailable = true;
            this.failProcessing(error);
          });
        }
        await this.backgroundLifecycle.start();
        await this.collectionClock.synchronize();
        this.arm();
      } catch (error) {
        this.failProcessing(error);
      }
    });
  }

  stop(): Promise<void> {
    return this.control(async () => {
      if (!this.started) return;
      this.started = false;
      this.collectionClock.stop();
      this.deviceId = undefined;
      this.clock.clear();
      this.active.abort("learning_stopped");
      await Promise.all([this.active.settle(), this.backgroundLifecycle.stop()]);
      await this.preserveQueued();
      this.queue.stopExpiry();
      this.journal.stop();
      this.state = "off";
      this.changed();
    });
  }

  configure(
    input: Partial<PassiveLearningPreferences>,
  ): Promise<PassiveLearningStatus> {
    return this.control(async () => {
      await this.initialize();
      let next = normalizeLearningPreferences(input, this.preferences);
      const previous = this.preferences;
      validateLearningActivityModels(previous, next, (profile) => this.background.model.validateProfile(profile));
      const validateProcessing = requiresLearningAvailability(previous, next, this.processingUnavailable, input);
      if (validateProcessing)
        await this.requireAvailable(next);
      await this.backgroundLifecycle.validatePreferences(previous, next);
      try {
        await commitLearningApplicationPreferences({ previous, next, active: this.active,
          suspend: () => {
            this.changingApplications = true; this.clock.clear();
            return () => { this.changingApplications = false; this.arm(); };
          },
          commit: async () => {
            next = await commitLearningMaturationPreferences(this.background.memory, next, input,
              { previous, persist: (value) => this.journal.persist(value) });
            this.preferences = next;
          },
        });
      } catch (error) {
        this.failProcessing(error);
        throw error;
      }
      if (validateProcessing) {
        this.processingUnavailable = false;
        this.processingReason = undefined;
      }
      this.processingCycle.preferencesChanged(previous, next, validateProcessing);
      this.clock.clear(hasAnalysisScheduleChanged(previous, next));
      if (next.processingPaused) {
        this.active.abort("learning_processing_paused");
        await this.active.settle();
      }
      if (!next.enabled || next.processingPaused) await this.preserveQueued();
      await this.collectionClock.synchronize(requiresCollectionConnection(previous, next));
      await this.processingCycle.reconcile().catch((error) => this.failProcessing(error));
      await this.backgroundLifecycle.preferencesChanged();
      this.arm();
      this.changed();
      return this.status();
    });
  }

  restartCollection(): Promise<PassiveLearningStatus> {
    return this.control(async () => {
      if (canRestartPermissionBlockedCollection(this.canCollect(), this.state))
        await this.collectionClock.synchronize(true);
      return this.status();
    });
  }

  async status(): Promise<PassiveLearningStatus> {
    this.queue.expire(this.now());
    return buildLearningServiceStatus({ background: this.background, preferences: this.preferences,
      history: this.journal.items, state: this.state, reason: this.reason, processingReason: this.processingReason,
      budgetReason: this.processingCycle.deferral?.reason, deviceId: this.deviceId, lastObservationAt: this.lastObservationAt,
      queued: this.queue.items, dropped: this.queue.dropped, active: this.active.size, reviewPassRemaining: this.processingCycle.remainingPass(),
      concurrency: this.effectiveConcurrency(), nextAnalysisAt: this.clock.scheduledAt,
      nextCollectionAt: this.collectionClock.scheduledAt, maintenanceReason: this.backgroundLifecycle.maintenanceReason,
      proactiveStartupReason: this.backgroundLifecycle.proactiveStartupReason,
      reassessmentStartupReason: this.backgroundLifecycle.reassessmentStartupReason });
  }
  async batches(
    input: Readonly<{ limit?: number }> = {},
  ): Promise<readonly LearningBatchSummary[]> {
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
    return this.journal.items.slice(-limit).reverse().map(summarizeBatch);
  }
  async batch(id: string): Promise<LearningBatch | undefined> {
    const found = this.journal.items.find((batch) => batch.id === id);
    if (!found) return undefined;
    const { reviewProgress: _reviewProgress, ...detail } = found;
    return detail;
  }

  accept(event: HostObservationEvent): void {
    if (!this.source.accepts(event)) return;
    if (this.deviceId && this.deviceId !== event.deviceId) {
      this.state = "unavailable";
      this.reason = "learning_device_changed";
      this.source.close();
      this.changed();
      return;
    }
    this.deviceId = event.deviceId;
    if (event.type === "status") {
      this.state = event.state;
      this.reason = event.reason;
      this.changed();
      return;
    }
    const observation = event.observation;
    const previous = this.sequences.get(event.deviceId) ?? -1;
    if (observation.sequence <= previous) return;
    if (previous >= 0 && observation.sequence > previous + 1)
      this.queue.dropped += observation.sequence - previous - 1;
    this.sequences.set(event.deviceId, observation.sequence);
    if (isLearningApplicationExcluded(observation.source.app, this.preferences.excludedApplications)) return;
    this.lastObservationAt = observation.timestamp;
    if (
      !this.queue.add({ ...observation, deviceId: event.deviceId }, this.now())
    )
      return;
    this.changed();
    this.arm();
  }

  flush(): Promise<void> {
    return this.processingCycle.flush();
  }

  beginInteractive(): () => void {
    this.interactive += 1;
    const releaseBackground = this.backgroundLifecycle.beginInteractive();
    this.clock.clear();
    this.active.abort("learning_interactive_preempted");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.interactive -= 1;
      releaseBackground();
      this.arm();
    };
  }
  subscribe(listener: (event?: LearningChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(batch: LearningBatch): void {
    this.active.dispatch({
      batch,
      modelProfileId: this.preferences.modelProfileId!,
      model: this.background.model,
      memory: this.background.memory,
      ownerId: this.options.ownerId,
      isCurrent: () => batch.generation === this.generation,
      timestamp: () => this.timestamp(),
      replace: (value) => this.journal.replace(value),
      partition: (values) => this.journal.partition(values),
      failed: (error) => this.failProcessing(error),
      succeeded: () => {
        this.processingReason = undefined;
        this.notifyKnowledgeChanged();
        this.changed();
      },
    }, () => {
      this.changed();
      this.arm();
      this.background.reassessment?.knowledgeChanged();
    });
    this.changed();
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.preferences = await projectLearningMaturationPreferences(this.background.memory, await this.journal.load(this.generation), true);
    this.initialized = true;
  }
  private async requireAvailable(
    preferences: PassiveLearningPreferences,
  ): Promise<void> {
    if (!preferences.modelProfileId) throw new Error("learning_model_required");
    this.background.model.validateProfile(preferences.modelProfileId);
    const memory = await this.background.memory.status();
    if (
      !memory.enabled ||
      !memory.available ||
      !hasLearningMemoryWriter(this.background)
    )
      throw new Error("learning_memory_unavailable");
  }

  clearPending(): Promise<PassiveLearningStatus> {
    return this.control(async () => {
      await this.initialize();
      this.closing = true;
      this.generation = randomUUID();
      this.clock.clear();
      this.queue.clear();
      this.active.abort("learning_pending_deleted");
      try {
        await this.active.settle();
        await this.journal.clearPending();
      } finally {
        this.closing = false;
        this.changed();
        this.arm();
      }
      return this.status();
    });
  }

  private async preserveQueued(): Promise<void> {
    const pending: LearningBatch[] = [];
    while (this.queue.length) {
      const observations = this.queue.take(this.now());
      if (!observations.length) break;
      pending.push(
        createPendingLearningBatch(observations, this.generation, this.now()),
      );
    }
    if (pending.length) await this.journal.replaceMany(pending);
  }

  private canProcess(): boolean {
    if (!this.canReconcileReceipts()) return false;
    return !this.isInteractiveBusy();
  }
  private canReconcileReceipts(): boolean {
    if (this.processingUnavailable) return false;
    if (!this.started || this.closing || this.changingApplications || !this.journal.storageAvailable)
      return false;
    if (this.preferences.processingPaused || !this.preferences.modelProfileId)
      return false;
    return true;
  }
  private isInteractiveBusy(): boolean { return this.interactive > 0 || this.options.isInteractiveBusy?.() === true; }
  private canCollect(): boolean {
    if (!this.started || !this.preferences.enabled) return false;
    return isWithinAnalysisWindow(this.now(), this.preferences.collectionWindow);
  }
  private effectiveConcurrency(): number {
    const profile = this.preferences.modelProfileId;
    if (!profile) return 1;
    try {
      return this.background.model.supportsParallelBatches?.(profile)
        ? (this.preferences.maxConcurrentBatches ?? 1)
        : 1;
    } catch {
      return 1;
    }
  }
  private intervalMs(): number {
    return (
      this.options.batchDelayMs ??
      (this.preferences.analysisIntervalMinutes ?? 15) * 60_000
    );
  }
  private arm(): void {
    if (!this.canProcess() || this.active.size >= this.effectiveConcurrency())
      return;
    if (!this.processingCycle.hasReadyWork()) { this.clock.clear(); return; }
    this.clock.arm(
      this.now(),
      this.processingCycle.delayMs(),
      this.preferences.analysisWindow,
      this.processingCycle.deferral?.until,
    );
  }
  async dismissProposal(id: string): Promise<void> {
    if (!this.background.proactive) throw new Error("proactive_unavailable");
    await this.background.proactive.dismiss(id);
  }
  notifyKnowledgeChanged(): void {
    this.backgroundLifecycle.knowledgeChanged();
  }
  async sessionDeleted(sessionId: string): Promise<void> { await this.background.proactive?.sessionDeleted?.(sessionId); }
  async candidates() {
    const records = await this.background.memory.learning?.list() ?? [];
    return records.map(({ embedding: _embedding, ...record }) => record);
  }
  private changed(event?: LearningChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
  private failFeature(error: unknown): void {
    this.reason = learningFailureReason(error);
    this.state =
      this.reason === "learning_host_unavailable" ? "unavailable" : "failed";
    this.changed();
  }
  private failProcessing(error: unknown): void {
    this.processingReason = this.processingCycle?.noteFailure(error) ? undefined : learningFailureReason(error);
    this.changed();
  }
  private control<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.controls.then(operation);
    this.controls = next.catch(() => {});
    return next;
  }
}
