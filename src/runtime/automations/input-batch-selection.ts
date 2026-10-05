const MAX_BATCH_BYTES = 32 * 1024 * 1024;

type SizedInput = Readonly<{ file: Readonly<{ sizeBytes: number }> }>;

export function selectAutomationInputBatch<T extends SizedInput>(
  candidates: readonly T[],
  minimumFiles: number,
  maxFiles: number,
): T[] {
  const waitingForMinimumInputs = candidates.length < minimumFiles;
  if (waitingForMinimumInputs) return [];
  const minimumExceedsFileLimit = minimumFiles > maxFiles;
  if (minimumExceedsFileLimit) throw new Error("automation_source_capacity_exceeded");
  const preferred = fillAvailableBatch(candidates, [], maxFiles);
  const preferredMeetsMinimum = preferred.length >= minimumFiles;
  if (preferredMeetsMinimum) return preferred;

  // The smallest minimumFiles prove whether any threshold-sized batch can fit.
  // Preserve source order normally; only replace an infeasible preferred prefix.
  const minimum = [...candidates].sort((left, right) =>
    left.file.sizeBytes - right.file.sizeBytes).slice(0, minimumFiles);
  const minimumExceedsByteLimit = batchBytes(minimum) > MAX_BATCH_BYTES;
  if (minimumExceedsByteLimit) throw new Error("automation_source_capacity_exceeded");
  const selected = new Set(fillAvailableBatch(candidates, minimum, maxFiles));
  return candidates.filter((candidate) => selected.has(candidate));
}

function batchBytes(candidates: readonly SizedInput[]): number {
  return candidates.reduce((bytes, candidate) => bytes + candidate.file.sizeBytes, 0);
}

function fillAvailableBatch<T extends SizedInput>(
  candidates: readonly T[],
  selected: T[],
  maxFiles: number,
): T[] {
  let bytes = batchBytes(selected);
  const included = new Set(selected);
  for (const candidate of candidates) {
    const reachedFileLimit = selected.length >= maxFiles;
    if (reachedFileLimit) break;
    if (included.has(candidate)) continue;
    const fitsRemainingBytes = bytes + candidate.file.sizeBytes <= MAX_BATCH_BYTES;
    if (!fitsRemainingBytes) continue;
    selected.push(candidate);
    included.add(candidate);
    bytes += candidate.file.sizeBytes;
  }
  return selected;
}
