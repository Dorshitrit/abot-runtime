import { createHash } from "node:crypto";

export const MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS = 86_400_000;
export const MAX_CO_WORKER_REVIEW_PROGRESS_BYTES = 256 * 1024;
export const MAX_CO_WORKER_REVIEW_STAGES = 24;

export type CoWorkerReviewProgress = Readonly<{
  schemaVersion: 1;
  method: "super-v2";
  binding: string;
  referenceTime: string;
  expiresAt: string;
  stages: readonly Readonly<{ key: string; fingerprint: string; response: string; acceptedAt: string }>[];
}>;

/** Persistence belongs to the existing batch/proactive state owner, never the model. */
export type ReviewProgressPort = Readonly<{
  read(): CoWorkerReviewProgress | undefined;
  save(progress: CoWorkerReviewProgress | undefined): Promise<void>;
}>;

export function fingerprintReviewProgress(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Bound all persisted text; individual outputs are revalidated by their stage decoder. */
export function readCoWorkerReviewProgress(value: unknown): CoWorkerReviewProgress | undefined {
  if (value === undefined) return undefined;
  if (!isProgressObject(value)) throw progressInvalid();
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CO_WORKER_REVIEW_PROGRESS_BYTES) throw progressInvalid();
  if (value.schemaVersion !== 1 || value.method !== "super-v2") throw progressInvalid();
  if (!isProgressFingerprint(value.binding)) throw progressInvalid();
  if (!isProgressTimestamp(value.referenceTime) || !isProgressTimestamp(value.expiresAt)) throw progressInvalid();
  const age = Date.parse(value.expiresAt) - Date.parse(value.referenceTime);
  if (age <= 0 || age > MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS) throw progressInvalid();
  if (!Array.isArray(value.stages) || value.stages.length > MAX_CO_WORKER_REVIEW_STAGES) throw progressInvalid();
  const seen = new Set<string>();
  const stages = value.stages.map(stage => {
    if (!isProgressObject(stage)) throw progressInvalid();
    if (!isReviewStageKey(stage.key) || seen.has(stage.key)) throw progressInvalid();
    if (!isProgressFingerprint(stage.fingerprint)) throw progressInvalid();
    if (!isProgressTimestamp(stage.acceptedAt)) throw progressInvalid();
    if (typeof stage.response !== "string" || !stage.response.length) throw progressInvalid();
    seen.add(stage.key);
    return Object.freeze({ key: stage.key, fingerprint: stage.fingerprint, response: stage.response, acceptedAt: stage.acceptedAt });
  });
  return Object.freeze({ schemaVersion: 1, method: "super-v2", binding: value.binding,
    referenceTime: value.referenceTime, expiresAt: value.expiresAt, stages: Object.freeze(stages) });
}

export function isReviewStageKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(value);
}
function isProgressFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isProgressTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && Number.isFinite(Date.parse(value));
}
function isProgressObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}
function progressInvalid(): Error { return new Error("learning_review_progress_invalid"); }
