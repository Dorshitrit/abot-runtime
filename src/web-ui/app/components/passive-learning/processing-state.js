/** Queue totals exclude the batches already being processed. */
export function isObservationReviewActive(status) {
  if (status?.processing) return true;
  return status?.activeBatches > 0;
}

export function observationReviewSummary(status) {
  const batches = status?.activeBatches || 0;
  const waiting = status?.pendingObservations || 0;
  const running = batches > 0 ? `${batches} ${batches === 1 ? "batch" : "batches"} in progress` : "Review in progress";
  const queue = waiting > 0 ? `${waiting} waiting` : "No observations waiting";
  return `${running} · ${queue}`;
}
