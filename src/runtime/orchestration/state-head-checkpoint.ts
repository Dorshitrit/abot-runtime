/** Restored channels retain monotonic revisions but issue fresh local authority. */
export function readInitialCanonicalRevision(
  options: Readonly<{ initialRevision: number }> | undefined,
): number {
  if (options === undefined) return 0;
  if (!Number.isSafeInteger(options.initialRevision))
    throw new Error("canonical_state_checkpoint_revision_invalid");
  if (options.initialRevision < 0)
    throw new Error("canonical_state_checkpoint_revision_invalid");
  return options.initialRevision;
}
