/** Shared limits for event-driven native readers; these are not polling intervals. */
export const OBSERVATION_CAPTURE_POLICY = Object.freeze({
  minimumIntervalMs: 5_000,
  burstWindowMs: 30_000,
  burstLimit: 4,
  resumeQuietMs: 30_000,
});
