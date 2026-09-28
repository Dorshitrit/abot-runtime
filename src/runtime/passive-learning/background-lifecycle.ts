import type { LearningBackgroundDependencies, LearningProactiveLifecycle } from "./background-dependencies.js";
import type { PassiveLearningPreferences } from "./contracts.js";

/** Feature lifecycle coordination; no timers or model work beyond each owning activity. */
export class LearningBackgroundLifecycle {
  private unsubscribeMaintenance: (() => void) | undefined;
  private unsubscribeKnowledge: (() => void) | undefined;
  get maintenanceReason(): string | undefined { return this.options.background.memory.retention?.reason(); }
  proactiveStartupReason: string | undefined;
  reassessmentStartupReason: string | undefined;
  constructor(private readonly options: {
    background: LearningBackgroundDependencies; changed(): void;
  }) {}
  async validatePreferences(previous: PassiveLearningPreferences, next: PassiveLearningPreferences): Promise<void> {
    if (!next.proactiveEnabled) return;
    const profile = next.proactiveModelProfileId ?? next.modelProfileId;
    if (previous.proactiveEnabled && profile === (previous.proactiveModelProfileId ?? previous.modelProfileId)) return;
    if (!profile) throw new Error("proactive_model_required");
    this.options.background.model.validateProfile(profile);
    const memory = await this.options.background.memory.status();
    if (!memory.enabled || !memory.available || !this.options.background.memory.learning)
      throw new Error("learning_memory_unavailable");
    if (!this.options.background.proactive) throw new Error("proactive_unavailable");
  }
  async start(): Promise<void> {
    this.proactiveStartupReason = undefined;
    this.reassessmentStartupReason = undefined;
    this.unsubscribeMaintenance ??= this.options.background.memory.retention?.subscribeChanges(this.options.changed);
    this.unsubscribeKnowledge ??= this.options.background.memory.subscribeChanges?.(() => {
      this.knowledgeChanged();
      this.options.changed();
    });
    await this.startIndependentActivity(this.options.background.proactive, () => {
      this.proactiveStartupReason = "proactive_start_failed";
    });
    await this.startIndependentActivity(this.options.background.reassessment, () => {
      this.reassessmentStartupReason = "learning_reassessment_start_failed";
    });
  }
  private async startIndependentActivity(
    activity: Pick<LearningProactiveLifecycle, "start" | "stop"> | undefined,
    failed: () => void,
  ): Promise<void> {
    if (!activity) return;
    try {
      await activity.start();
    } catch {
      failed();
      // A failed startup can leave an activity partially armed; settle it once.
      await activity.stop().catch(() => {});
      this.options.changed();
    }
  }
  async stop(): Promise<void> {
    this.unsubscribeMaintenance?.();
    this.unsubscribeMaintenance = undefined;
    this.unsubscribeKnowledge?.();
    this.unsubscribeKnowledge = undefined;
    await Promise.all([this.options.background.proactive?.stop(), this.options.background.reassessment?.stop()]);
  }
  async preferencesChanged(): Promise<void> {
    await this.options.background.proactive?.preferencesChanged();
    await this.options.background.reassessment?.preferencesChanged();
  }
  knowledgeChanged(): void {
    this.options.background.proactive?.knowledgeChanged();
    this.options.background.reassessment?.knowledgeChanged();
  }
  beginInteractive(): () => void {
    const releases = [this.options.background.proactive?.beginInteractive(), this.options.background.reassessment?.beginInteractive()];
    return () => { for (const release of releases) release?.(); };
  }
}
