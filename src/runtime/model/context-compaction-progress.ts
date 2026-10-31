/** Invocation-local observations; never part of a model prompt or checkpoint. */
export type CompactionProgress = Readonly<{
  step: "processing" | "merging" | "checking";
  unit?: "sources" | "turns";
  completedUnits?: number;
  totalUnits?: number;
  completedBytes?: number;
  totalBytes?: number;
}>;
export type CompactionProgressObserver = (progress: CompactionProgress) => void;

export function formatCompactionProgress(
  progress: CompactionProgress,
  scope: string,
  attempt: number,
): string {
  const parts = ["Compacting context", scope === "session_history" ? "history" : "active request"];
  if (attempt > 1) parts.push("repair");
  if (progress.unit && progress.completedUnits !== undefined && progress.totalUnits !== undefined)
    parts.push(`${progress.completedUnits}/${progress.totalUnits} ${progress.unit} processed`);
  if (progress.totalBytes && progress.completedBytes !== undefined)
    parts.push(`${progress.completedBytes}/${progress.totalBytes} bytes`);
  parts.push(progress.step === "checking" ? "checking budget" : progress.step);
  return parts.join(" · ");
}

/** Sharing history work also shares observations, without changing its promise or commit. */
export function createCompactionProgressFanout() {
  const observers = new Set<CompactionProgressObserver>();
  let latest: CompactionProgress | undefined;
  return {
    add(observer?: CompactionProgressObserver) {
      if (!observer) return;
      observers.add(observer);
      if (latest) observer(latest);
    },
    report(progress: CompactionProgress) {
      latest = progress;
      for (const observer of observers) observer(progress);
    },
    clear() {
      observers.clear();
      latest = undefined;
    },
  };
}
