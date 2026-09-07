export class SchedulerValidationError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "SchedulerValidationError";
  }
}
