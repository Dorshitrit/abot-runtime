import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../adapters/long-term-memory/file-lock/contracts.js";
import type { LearningKnowledgeContext, LearningKnowledgeEntry } from "../long-term-memory/maturation/contracts.js";
import { readCoWorkerReviewProgress, type CoWorkerReviewProgress } from "./review-progress.js";

type Binding = Pick<LearningKnowledgeEntry, "kind" | "id" | "version">;
export const MAX_REASSESSMENT_BINDINGS = 500;
const MAX_STATE_BYTES = 128 * 1024;

type ReassessmentState = Readonly<{
  schemaVersion: 1; fingerprint: string | null; attemptedAt: number; reason: string | null;
  blockedEntries: readonly Binding[];
  reviewProgress?: CoWorkerReviewProgress;
  reviewEntries?: readonly Binding[];
}>;
const EMPTY: ReassessmentState = Object.freeze({ schemaVersion: 1, fingerprint: null, attemptedAt: 0, reason: null, blockedEntries: [] });

export function learningReassessmentFingerprint(context: LearningKnowledgeContext): string {
  const entries = context.entries.map(({ kind, id, version, reconsiderAt }) => ({ kind, id, version, reconsiderAt }));
  entries.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Bounded exact-version receipts prevent repeated inference while other due entries advance. */
export function createReassessmentStateStore(directory: string) {
  const file = join(directory, "knowledge-reassessment.json");
  async function read(): Promise<ReassessmentState> {
    try {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_STATE_BYTES) throw new Error("learning_reassessment_state_invalid");
        const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        if (!parsed || typeof parsed !== "object") throw new Error("learning_reassessment_state_invalid");
        const value = parsed as ReassessmentState;
        if (value.schemaVersion !== 1 || !Number.isFinite(value.attemptedAt) || value.attemptedAt < 0)
          throw new Error("learning_reassessment_state_invalid");
        if (value.fingerprint !== null && !/^[a-f0-9]{64}$/u.test(value.fingerprint)) throw new Error("learning_reassessment_state_invalid");
        if (value.reason !== null && (typeof value.reason !== "string" || !/^[a-z][a-z0-9_]{0,100}$/u.test(value.reason)))
          throw new Error("learning_reassessment_state_invalid");
        if (!Array.isArray(value.blockedEntries) || value.blockedEntries.length > MAX_REASSESSMENT_BINDINGS || value.blockedEntries.some((entry) => !isBinding(entry)))
          throw new Error("learning_reassessment_state_invalid");
        const reviewProgress = readCoWorkerReviewProgress(value.reviewProgress);
        if (reviewProgress && (!value.fingerprint || !Array.isArray(value.reviewEntries) ||
            value.reviewEntries.length > MAX_REASSESSMENT_BINDINGS || value.reviewEntries.some((entry) => !isBinding(entry))))
          throw new Error("learning_reassessment_state_invalid");
        return { schemaVersion: 1, fingerprint: value.fingerprint, attemptedAt: value.attemptedAt,
          reason: value.reason, blockedEntries: value.blockedEntries.map(({ kind, id, version }) => ({ kind, id, version })),
          ...(reviewProgress ? { reviewProgress, reviewEntries: value.reviewEntries } : {}) };
      } finally { await handle.close(); }
    } catch (error) { if (fileSystemErrorCode(error) === "ENOENT") return EMPTY; throw error; }
  }
  async function update(change: (state: ReassessmentState) => ReassessmentState): Promise<ReassessmentState> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(`${file}.lock`, async () => {
      const previous = await read(); const next = change(previous);
      if (next === previous) return previous;
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("learning_reassessment_capacity");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
        return next;
      } finally { await rm(temporary, { force: true }); }
    });
  }
  return Object.freeze({
    read,
    async reserve(fingerprint: string, entries: readonly Binding[], now: number, assertCurrent: () => void): Promise<boolean> {
      let reserved = false;
      await update((state) => {
        assertCurrent();
        if (entries.some((entry) => state.blockedEntries.some((blocked) => sameBinding(entry, blocked)))) return state;
        const blockedEntries = [...state.blockedEntries, ...entries];
        if (blockedEntries.length > MAX_REASSESSMENT_BINDINGS) throw new Error("learning_reassessment_capacity");
        reserved = true;
        const canResumeProgress = state.fingerprint === fingerprint && state.reviewProgress && now < Date.parse(state.reviewProgress.expiresAt);
        return { schemaVersion: 1, fingerprint, attemptedAt: now, reason: null, blockedEntries,
          ...(canResumeProgress ? { reviewProgress: state.reviewProgress, reviewEntries: state.reviewEntries } : {}) };
      });
      return reserved;
    },
    async failed(fingerprint: string, entries: readonly Binding[], reason: string, retryable: boolean): Promise<void> {
      await update((state) => state.fingerprint !== fingerprint ? state : {
        ...state, fingerprint: retryable && !state.reviewProgress ? null : fingerprint, reason,
        blockedEntries: retryable ? withoutBindings(state.blockedEntries, entries) : state.blockedEntries,
        reviewProgress: retryable ? state.reviewProgress : undefined,
        reviewEntries: retryable ? state.reviewEntries : undefined,
      });
    },
    async complete(fingerprint: string, entries: readonly Binding[]): Promise<void> {
      await update((state) => state.fingerprint !== fingerprint ? state : {
        ...state, fingerprint: null, reason: null, blockedEntries: withoutBindings(state.blockedEntries, entries),
        reviewProgress: undefined, reviewEntries: undefined,
      });
    },
    async retryBlocked(): Promise<void> {
      await update((state) => !state.blockedEntries.length ? state : {
        ...state, fingerprint: state.reviewProgress ? state.fingerprint : null, reason: null, blockedEntries: [],
      });
    },
    async saveProgress(fingerprint: string, entries: readonly Binding[], progress: CoWorkerReviewProgress | undefined,
      assertCurrent: () => void = () => {}): Promise<void> {
      await update((state) => {
        assertCurrent();
        if (state.fingerprint !== fingerprint) throw new Error("learning_generation_superseded");
        return { ...state, reviewProgress: progress, reviewEntries: progress ? entries : undefined };
      });
    },
    async resumeProgress(now: number): Promise<ReassessmentState> {
      return update((state) => {
        if (!state.reviewProgress) return state;
        const unexpired = now < Date.parse(state.reviewProgress.expiresAt);
        const blockedEntries = withoutBindings(state.blockedEntries, state.reviewEntries ?? []);
        if (unexpired && blockedEntries.length === state.blockedEntries.length) return state;
        return { ...state, blockedEntries,
          reviewProgress: unexpired ? state.reviewProgress : undefined,
          reviewEntries: unexpired ? state.reviewEntries : undefined };
      });
    },
  });
}

function sameBinding(left: Binding, right: Binding): boolean {
  return left.kind === right.kind && left.id === right.id && left.version === right.version;
}
function withoutBindings(values: readonly Binding[], removed: readonly Binding[]): readonly Binding[] {
  return values.filter((value) => !removed.some((entry) => sameBinding(entry, value)));
}
function isBinding(value: unknown): value is Binding {
  if (!value || typeof value !== "object") return false;
  const entry = value as Binding;
  return (entry.kind === "candidate" || entry.kind === "memory") &&
    [entry.id, entry.version].every((text) => typeof text === "string" && text.length > 0 && text.length <= 160);
}
