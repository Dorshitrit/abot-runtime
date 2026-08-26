export async function selectLargestFittingPrefix<T>(params: {
  entries: readonly T[];
  fits: (entries: readonly T[]) => Promise<boolean>;
}): Promise<readonly T[]> {
  let low = 1;
  let high = params.entries.length;
  let selectedCount = 0;
  while (low <= high) {
    const candidateCount = Math.floor((low + high) / 2);
    const candidate = params.entries.slice(0, candidateCount);
    if (await params.fits(candidate)) {
      selectedCount = candidateCount;
      low = candidateCount + 1;
    } else {
      high = candidateCount - 1;
    }
  }
  return Object.freeze(params.entries.slice(0, selectedCount));
}
