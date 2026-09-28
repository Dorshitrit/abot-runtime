import { createHash } from "node:crypto";
import type { LearningObservation } from "./contracts.js";
import { PASSIVE_OBSERVATION_RETENTION_MS as RETENTION_MS } from "../../shared/passive-observation.js";

export const MAX_PENDING_OBSERVATIONS = 256;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const STORAGE_PRESSURE_BYTES = Math.floor(MAX_PENDING_BYTES * 0.8);
const STORAGE_PRESSURE_COUNT = Math.floor(MAX_PENDING_OBSERVATIONS * 0.8);
const observationSizes = new WeakMap<LearningObservation, number>();

/** Eligible evidence may need review before its count can fill the bounded queue. */
export function hasObservationStoragePressure(observations: readonly LearningObservation[]): boolean {
  if (observations.length >= STORAGE_PRESSURE_COUNT) return true;
  let bytes = 0;
  for (const observation of observations) {
    bytes += observationStorageSize(observation);
    if (bytes >= STORAGE_PRESSURE_BYTES) return true;
  }
  return false;
}

function observationStorageSize(observation: LearningObservation): number {
  const cached = observationSizes.get(observation);
  if (cached !== undefined) return cached;
  const size = Buffer.byteLength(JSON.stringify(observation));
  observationSizes.set(observation, size);
  return size;
}

export class ObservationQueue {
  private pending: LearningObservation[] = [];
  private readonly seen = new Map<string, number>();
  private lastSource: string | undefined;
  private lastFingerprint: string | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryClock: { now(): number; changed(): void } | undefined;
  dropped = 0;

  constructor(private readonly canProcess: (item: LearningObservation) => boolean = () => true) {}

  get length(): number {
    return this.pending.length;
  }
  get items(): readonly LearningObservation[] { return this.pending; }
  clear(): void {
    this.pending = [];
    this.seen.clear();
    this.lastSource = undefined;
    this.lastFingerprint = undefined;
    this.armExpiry();
  }

  startExpiry(clock: { now(): number; changed(): void }): void {
    this.expiryClock = clock;
    this.expire(clock.now());
  }

  stopExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.expiryClock = undefined;
  }

  add(observation: LearningObservation, now: number): boolean {
    this.expire(now);
    if (now - Date.parse(observation.timestamp) >= RETENTION_MS) {
      this.dropped += 1;
      return false;
    }
    const content = observation.content.replace(/\r\n/gu, "\n").trim();
    let normalized: LearningObservation = Object.freeze({
      ...observation,
      content,
    });
    const identity = documentIdentity(normalized);
    const sourceChanged = this.lastSource !== identity;
    this.lastSource = identity;
    const explicitRevisit = Boolean(observation.revisitsObservationId);
    if (!content && !sourceChanged && !explicitRevisit) return false;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          identity,
          normalized.kind,
          content,
          normalized.coverage,
        ]),
      )
      .digest("hex");
    const earlier = this.seen.get(fingerprint);
    if (
      fingerprint === this.lastFingerprint &&
      !sourceChanged &&
      !explicitRevisit
    )
      return false;
    this.lastFingerprint = fingerprint;
    if (earlier !== undefined && sourceChanged)
      normalized = Object.freeze({
        ...normalized,
        content: "",
        kind: "activity",
        coverage: "metadata_only",
        coverageReason:
          "Repeated visit; previously observed content is unchanged.",
        revisit: {
          firstObservedAt: new Date(earlier).toISOString(),
          contentUnchanged: true as const,
        },
      });
    this.seen.set(fingerprint, now);
    const last = this.pending.at(-1);
    if (canSettleDraft(last, normalized)) this.pending.pop();
    this.pending.push(normalized);
    this.enforceCapacity();
    this.armExpiry();
    return true;
  }

  take(now: number, eligible: (item: LearningObservation) => boolean = () => true): readonly LearningObservation[] {
    this.expire(now);
    const selected: LearningObservation[] = [];
    this.pending = this.pending.filter((item) => {
      if (selected.length >= 16 || !eligible(item)) return true;
      selected.push(item);
      return false;
    });
    this.armExpiry();
    return Object.freeze(selected);
  }

  expire(now: number): void {
    const before = this.pending.length;
    this.pending = this.pending.filter(
      (item) => now - Date.parse(item.timestamp) < RETENTION_MS,
    );
    this.dropped += before - this.pending.length;
    for (const [key, timestamp] of this.seen)
      if (now - timestamp > RETENTION_MS) this.seen.delete(key);
    while (this.seen.size > 4096)
      this.seen.delete(this.seen.keys().next().value!);
    this.armExpiry();
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.expiryClock || !this.pending.length) return;
    const clock = this.expiryClock;
    const expiry =
      Math.min(...this.pending.map((item) => Date.parse(item.timestamp))) +
      RETENTION_MS;
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        this.expire(clock.now());
        clock.changed();
      },
      Math.max(1, expiry - clock.now()),
    );
    this.expiryTimer.unref?.();
  }

  private enforceCapacity(): void {
    let bytes = this.pending.reduce(
      (total, item) => total + observationStorageSize(item),
      0,
    );
    while (this.pending.length > MAX_PENDING_OBSERVATIONS || bytes > MAX_PENDING_BYTES) {
      // Intake can fill the queue before an async review starts. Reserve its
      // bounded capacity for eligible evidence ahead of processing exclusions.
      const excluded = this.pending.findIndex((item) => !this.canProcess(item));
      const [removed] = this.pending.splice(Math.max(0, excluded), 1);
      bytes -= observationStorageSize(removed!);
      this.dropped += 1;
    }
  }
}

export function documentIdentity(observation: LearningObservation): string {
  const source = observation.source;
  return JSON.stringify([
    observation.deviceId,
    source.app,
    source.processId,
    source.windowId,
    source.documentId,
    source.url,
    source.title,
  ]);
}

function canSettleDraft(
  previous: LearningObservation | undefined,
  next: LearningObservation,
): boolean {
  if (!previous || previous.kind !== "edit" || next.kind !== "edit")
    return false;
  if (documentIdentity(previous) !== documentIdentity(next)) return false;
  return Date.parse(next.timestamp) - Date.parse(previous.timestamp) <= 10_000;
}
