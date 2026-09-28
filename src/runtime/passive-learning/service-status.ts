import { projectLearningMaturationPreferences } from "./maturation-preferences.js";
import type { PassiveCollectionState } from "../../shared/passive-observation.js";
import { PASSIVE_OBSERVATION_RETENTION_MS } from "../../shared/passive-observation.js";
import type { LearningBackgroundDependencies } from "./background-dependencies.js";
import type { LearningBatch, LearningObservation, PassiveLearningPreferences, PassiveLearningStatus } from "./contracts.js";
import { recentLearningMemories, summarizeBatch } from "./status-projection.js";
import { learningApplicationCatalog } from "./application-catalog.js";
import { canProcessLearningObservation } from "./application-policy.js";

export async function buildLearningServiceStatus(input: Readonly<{
  background: LearningBackgroundDependencies;
  preferences: PassiveLearningPreferences;
  history: readonly LearningBatch[];
  state: "off" | PassiveCollectionState;
  reason?: string;
  processingReason?: string;
  budgetReason?: string;
  deviceId?: string;
  lastObservationAt?: string;
  queued: readonly LearningObservation[];
  reviewPassRemaining?: number;
  dropped: number;
  active: number;
  concurrency: number;
  nextAnalysisAt?: number;
  nextCollectionAt?: number;
  maintenanceReason?: string;
  proactiveStartupReason?: string;
  reassessmentStartupReason?: string;
}>): Promise<PassiveLearningStatus> {
  const [resourceUsage, proactive, recentMemories, preferences] = await Promise.all([
    readResourceUsage(input.background), readProactiveStatus(input.background, input.proactiveStartupReason),
    recentLearningMemories(input.background.memory, input.history),
    projectLearningMaturationPreferences(input.background.memory, input.preferences),
  ]);
  const reassessment = readReassessmentStatus(input.background, input.reassessmentStartupReason);
  const last = input.history.at(-1);
  const reason = input.processingReason ?? input.budgetReason ?? input.reason;
  const retained = [...input.queued, ...input.history.filter((batch) => batch.status === "pending")
    .flatMap((batch) => batch.observations)];
  const pending = retained.filter((observation) => canProcessLearningObservation(observation, input.preferences)).length;
  return {
    preferences,
    ...learningApplicationCatalog(input.queued, input.history, input.preferences),
    ...(resourceUsage ? { resourceUsage } : {}), ...(proactive ? { proactive } : {}),
    ...(reassessment ? { reassessment } : {}),
    ...(input.maintenanceReason ? { maintenanceReason: input.maintenanceReason } : {}),
    retentionHours: PASSIVE_OBSERVATION_RETENTION_MS / 3_600_000,
    state: input.processingReason ? "failed" : input.state,
    collectionState: input.state,
    ...(input.reason ? { collectionReason: input.reason } : {}),
    ...(input.processingReason ? { processingReason: input.processingReason } : {}),
    ...(reason ? { reason } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    pendingObservations: pending, blockedObservations: retained.length - pending, reviewPassRemaining: input.reviewPassRemaining,
    processing: input.active > 0, activeBatches: input.active, effectiveConcurrency: input.concurrency,
    ...(input.nextAnalysisAt === undefined ? {} : { nextAnalysisAt: new Date(input.nextAnalysisAt).toISOString() }),
    ...(input.nextCollectionAt === undefined ? {} : { nextCollectionAt: new Date(input.nextCollectionAt).toISOString() }),
    ...(input.lastObservationAt ? { lastObservationAt: input.lastObservationAt } : {}),
    ...(last ? { lastBatchAt: last.createdAt, lastBatch: summarizeBatch(last) } : {}),
    droppedObservations: input.dropped, recentMemories,
  };
}

async function readResourceUsage(background: LearningBackgroundDependencies) {
  try { return await background.resourceUsage?.(); }
  catch { return undefined; }
}

async function readProactiveStatus(background: LearningBackgroundDependencies, startupReason?: string) {
  if (startupReason) return { state: "failed" as const, reason: startupReason, proposals: [] };
  try { return await background.proactive?.status(); }
  catch { return { state: "failed" as const, reason: "proactive_failed", proposals: [] }; }
}

function readReassessmentStatus(background: LearningBackgroundDependencies, startupReason?: string) {
  if (startupReason) return { state: "failed" as const, reason: startupReason };
  return background.reassessment?.status();
}
