/** Keeps the bounded identity of rejected evidence, never its content. */
export class CompactionSourceInvariantError extends Error {
  readonly sourceRef: string | undefined;

  constructor(
    readonly code: string,
    sourceRef?: string,
  ) {
    super(code);
    this.name = "CompactionSourceInvariantError";
    this.sourceRef =
      sourceRef && sourceRef.length <= 256 ? sourceRef : undefined;
  }
}
