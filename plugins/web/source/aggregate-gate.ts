import { createAggregateGate as createSharedGate } from "../../../src/shared/public-http/aggregate-gate.js";
import { rethrowWebPluginError } from "./errors.js";

export function createAggregateGate(maxActive: number, maxQueued: number) {
  const gate = createSharedGate(maxActive, maxQueued);
  return Object.freeze({
    async run<T>(
      operation: () => Promise<T>,
      deadline: number,
      abortSignal?: AbortSignal,
    ): Promise<T> {
      try {
        return await gate.run(operation, deadline, abortSignal);
      } catch (error) {
        return rethrowWebPluginError(error);
      }
    },
  });
}
