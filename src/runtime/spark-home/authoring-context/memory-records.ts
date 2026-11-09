import type { LongTermMemoryRecord } from "../../long-term-memory/contracts.js";
import { AUTHORING_CONTEXT_LIMITS as limits, type AuthoringContextDependencies } from "./contracts.js";
import { contextFailure, requireSource } from "./projection.js";

function isPassive(record: LongTermMemoryRecord): boolean {
  return record.provenance.kind === "passive_observation" || (record.observationSources?.length ?? 0) > 0;
}

function latestFirst<T extends { updatedAt: string; id: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

/** Bounded service reads, before either planning or HTML-specific projection. */
export async function captureMemoryRecords(memory: AuthoringContextDependencies["memory"], now: Date) {
  if (!memory.enabled) return { enabled: false as const };
  return requireSource("memories", async () => {
    const status = await memory.status();
    if (!status.available) contextFailure("memories_unavailable", "Enabled memory storage is unavailable; SPARK HOME context was not prepared.");
    const [all, passiveCount] = await Promise.all([
      memory.list({ limit: limits.memoryScan, offset: Math.max(0, status.recordCount - limits.memoryScan) }),
      memory.list({ origin: "passive_observation", limit: 1 }),
    ]);
    const passive = passiveCount.total <= 1 ? passiveCount : await memory.list({
      origin: "passive_observation", limit: limits.memoryScan,
      offset: Math.max(0, passiveCount.total - limits.memoryScan),
    });
    if (!memory.learning) contextFailure("candidates_unavailable", "Enabled learning memory storage is unavailable; SPARK HOME context was not prepared.");
    const learning = memory.learning;
    const candidates = await requireSource("candidates", () => learning.list());
    const unexpired = candidates.filter(candidate => Date.parse(candidate.expiresAt) > now.getTime());
    return {
      enabled: true as const,
      saved: { records: latestFirst(all.items.filter(record => !isPassive(record))),
        availableCount: Math.max(0, all.total - passive.total), scannedCount: all.items.length },
      passive: { records: latestFirst(passive.items), availableCount: passive.total, scannedCount: passive.items.length },
      candidates: { records: latestFirst(unexpired), availableCount: unexpired.length, scannedCount: candidates.length,
        excludedExpiredCount: candidates.length - unexpired.length },
    };
  });
}

export type CapturedMemoryRecords = Awaited<ReturnType<typeof captureMemoryRecords>>;
