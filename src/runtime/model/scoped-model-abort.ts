import type { BoundRequestModelInvocationContext, RequestModelInvocationView } from "../request/contracts.js";

export function withModelInvocationAbort<T extends RequestModelInvocationView>(request: T, signal?: AbortSignal): T {
  if (!signal) return request;
  const abortSignal = AbortSignal.any([request.abortSignal, signal]);
  return Object.defineProperties(Object.create(Object.getPrototypeOf(request)), {
    ...Object.getOwnPropertyDescriptors(request),
    abortSignal: { value: abortSignal, enumerable: true },
  });
}

/** Keep the request-owned invocation counter while bounding nested compaction work. */
export function withModelAbortSignal<T extends BoundRequestModelInvocationContext>(
  request: T,
  signal: AbortSignal | undefined,
): T {
  if (!signal) return request;
  const abortSignal = AbortSignal.any([request.abortSignal, signal]);
  abortSignal.throwIfAborted();
  const modelSteps: BoundRequestModelInvocationContext["modelSteps"] = {
      invoke: (input) => request.modelSteps.invoke({
        ...input,
        abortSignal: input.abortSignal ? AbortSignal.any([abortSignal, input.abortSignal]) : abortSignal,
      }),
  };
  return Object.defineProperties(Object.create(Object.getPrototypeOf(request)), {
    ...Object.getOwnPropertyDescriptors(request),
    abortSignal: { value: abortSignal, enumerable: true },
    modelSteps: { value: modelSteps, enumerable: true },
  });
}
