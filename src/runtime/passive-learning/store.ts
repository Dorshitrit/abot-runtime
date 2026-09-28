import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LearningBatch, PassiveLearningPreferences } from "./contracts.js";
import { normalizeAnalysisSchedule } from "./analysis-schedule.js";
import { learningBatchExpiresAt } from "./batch-lifecycle.js";
import { DEFAULT_MATURATION_POLICY, normalizeMaturationPolicy } from "../long-term-memory/maturation/retention.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS, validateCoWorkerResourceLimits } from "./resources/contracts.js";
import { normalizeIndependentLearningPreferences } from "./independent-preferences.js";
import { normalizeLearningApplications } from "./application-policy.js";
import { DEFAULT_ANALYSIS_TRIGGER, DEFAULT_ANALYSIS_OBSERVATION_COUNT } from "./processing-trigger.js";
import { readObservationReviewPass } from "./processing-pass.js";
import { readCoWorkerReviewProgress } from "./review-progress.js";
import { normalizeLearningActivityControls } from "./activity-permissions.js";

export type LearningState = Readonly<{
  schemaVersion: 1;
  preferences: PassiveLearningPreferences;
  batches: readonly LearningBatch[];
  observationReviewPass?: readonly string[];
}>;
export const DEFAULT_LEARNING_PREFERENCES: PassiveLearningPreferences =
  Object.freeze({
    enabled: false,
    processingPaused: true,
    excludedApplications: Object.freeze([]),
    processingExcludedApplications: Object.freeze([]),
    analysisIntervalMinutes: 15,
    analysisTrigger: DEFAULT_ANALYSIS_TRIGGER,
    analysisObservationCount: DEFAULT_ANALYSIS_OBSERVATION_COUNT,
    analysisWindow: null,
    collectionWindow: null,
    proactiveEnabled: false,
    proactiveIntervalMinutes: 60,
    proactiveWindow: null,
    proactiveMessagesPerDay: 2,
    maxConcurrentBatches: 1,
    maturation: DEFAULT_MATURATION_POLICY,
    resourceLimits: DEFAULT_CO_WORKER_RESOURCE_LIMITS,
  });
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

export function createLearningStateStore(directory: string) {
  const file = join(directory, "state.json");
  return {
    async read(): Promise<LearningState> {
      try {
        const value: unknown = JSON.parse(await readFile(file, "utf8"));
        return parseState(value);
      } catch (error) {
        if (isMissing(error))
          return {
            schemaVersion: 1,
            preferences: DEFAULT_LEARNING_PREFERENCES,
            batches: [],
          };
        throw error;
      }
    },
    async write(state: LearningState): Promise<void> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state), {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

export function pruneLearningBatches(
  batches: readonly LearningBatch[],
  now: number,
): readonly LearningBatch[] {
  const candidates = batches
    .filter((batch) => now < learningBatchExpiresAt(batch))
    .slice(-50);
  let size = candidates.reduce(
    (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
    0,
  );
  while (size > HISTORY_MAX_BYTES && candidates.length)
    size -= Buffer.byteLength(JSON.stringify(candidates.shift()!));
  return candidates;
}

export function normalizeLearningPreferences(
  input: Partial<PassiveLearningPreferences>,
  previous: PassiveLearningPreferences,
): PassiveLearningPreferences {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("invalid_learning_preferences");
  if (
    input.processingPaused !== undefined &&
    typeof input.processingPaused !== "boolean"
  )
    throw new Error("invalid_learning_preferences");
  const profile = input.modelProfileId ?? previous.modelProfileId;
  if (
    profile !== undefined &&
    (typeof profile !== "string" || !profile.trim() || profile.length > 128)
  )
    throw new Error("invalid_learning_model_profile");
  const excluded = normalizeLearningApplications(input.excludedApplications ?? previous.excludedApplications);
  const processingExcluded = normalizeLearningApplications(
    input.processingExcludedApplications ?? previous.processingExcludedApplications ?? []);
  const maturation = normalizeMaturationPolicy(input.maturation ?? previous.maturation ?? DEFAULT_MATURATION_POLICY);
  const requestedConcurrency = input.maxConcurrentBatches ?? input.resourceLimits?.maxConcurrentCalls;
  if (input.maxConcurrentBatches !== undefined && input.resourceLimits !== undefined &&
      input.maxConcurrentBatches !== input.resourceLimits.maxConcurrentCalls)
    throw new Error("invalid_learning_preferences");
  const schedule = normalizeAnalysisSchedule({ ...input,
    ...(requestedConcurrency === undefined ? {} : { maxConcurrentBatches: requestedConcurrency }) }, previous);
  const resourceLimits = { ...(input.resourceLimits ?? previous.resourceLimits ?? DEFAULT_CO_WORKER_RESOURCE_LIMITS),
    maxConcurrentCalls: schedule.maxConcurrentBatches ?? 1 };
  validateCoWorkerResourceLimits(resourceLimits);
  return Object.freeze({
    ...(profile ? { modelProfileId: profile.trim() } : {}),
    excludedApplications: excluded,
    processingExcludedApplications: processingExcluded,
    ...schedule,
    ...normalizeIndependentLearningPreferences(input, previous),
    ...normalizeLearningActivityControls(input, previous),
    maturation: Object.freeze({ ...maturation }),
    resourceLimits: Object.freeze({ ...resourceLimits }),
  });
}

function parseState(value: unknown): LearningState {
  if (!value || typeof value !== "object")
    throw new Error("invalid_learning_state");
  const root = value as Record<string, unknown>;
  if (
    root.schemaVersion !== 1 ||
    !root.preferences ||
    typeof root.preferences !== "object" ||
    !Array.isArray(root.batches)
  )
    throw new Error("invalid_learning_state");
  const preferences = normalizeLearningPreferences(
    {
      ...(root.preferences as Partial<PassiveLearningPreferences>),
      analysisIntervalMinutes: (root.preferences as PassiveLearningPreferences).analysisIntervalMinutes ?? 5,
      processingPaused:
        (root.preferences as PassiveLearningPreferences).processingPaused ??
        !(root.preferences as PassiveLearningPreferences).enabled,
    },
    DEFAULT_LEARNING_PREFERENCES,
  );
  const batches = root.batches.map((item: unknown): LearningBatch => {
    if (!item || typeof item !== "object")
      throw new Error("invalid_learning_state");
    const batch = item as LearningBatch;
    if (
      typeof batch.id !== "string" ||
      typeof batch.generation !== "string" ||
      !Number.isFinite(Date.parse(batch.createdAt)) ||
      !Array.isArray(batch.observations) ||
      !Array.isArray(batch.recordIds)
    )
      throw new Error("invalid_learning_state");
    if (
      ![
        "pending",
        "processing",
        "saved",
        "reviewed",
        "discarded",
        "failed",
        "cancelled",
      ].includes(batch.status)
    )
      throw new Error("invalid_learning_state");
    const reviewProgress = readCoWorkerReviewProgress(batch.reviewProgress);
    return { ...batch, ...(reviewProgress ? { reviewProgress } : {}) };
  });
  const observationReviewPass = readObservationReviewPass(root.observationReviewPass);
  return { schemaVersion: 1, preferences, batches, ...(observationReviewPass ? { observationReviewPass } : {}) };
}
function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
