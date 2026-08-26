/**
 * Observes an unexpected thenable at a synchronous orchestration boundary.
 * Rejection handlers are attached immediately so the boundary can fail closed
 * without leaking an unhandled rejection into the process.
 */
export function consumeUnexpectedThenable(value: unknown): boolean {
  if (
    !(
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    )
  ) {
    return false;
  }
  try {
    const then = (value as { then?: unknown }).then;
    if (typeof then !== "function") return false;
    try {
      Reflect.apply(then, value, [() => undefined, () => undefined]);
    } catch {
      // The owning synchronous boundary reports the fault to its caller.
    }
    return true;
  } catch {
    return true;
  }
}
