/** HOME-owned source failures never alter generic payload authoring. */
export class SparkHomeContextError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SparkHomeContextError"; }
}
