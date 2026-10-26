import { InformationBasketError } from "./contracts.js";

/** Bounds even a nonconforming provider; late results cannot publish after abort. */
export function awaitBasketWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(signal.reason ?? new InformationBasketError("basket_operation_cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new InformationBasketError("basket_operation_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => {
      if (signal.aborted) { abort(); return; }
      resolve(value);
    }, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
