import type { WorkerCapabilityAdapterProvider } from "../../orchestration/worker-capabilities/index.js";
import { createRequestContextCompactionStore } from "../../context/semantic-compaction/index.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  createRequestExecutionScope,
  type CompiledRequestExecutionPolicy,
  type RequestCapabilityCompositionView,
  type RequestCapabilityExecutionView,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";

/** Flat fixture input accepted only while a test composes a canonical scope. */
export type TestRequestSeed = RequestExecutionSeed &
  Readonly<{
    workerCapabilityProvider: WorkerCapabilityAdapterProvider<unknown>;
  }>;

/** Builds the same immutable request scope used by the production handler. */
export function createTestRequestExecutionScope(
  input: TestRequestSeed,
  options: Readonly<{
    executionPolicy?: CompiledRequestExecutionPolicy;
  }> = {},
): RequestExecutionScope {
  const { workerCapabilityProvider, ...seed } = input;
  return createTestRequestExecutionScopeWithCapabilities(
    seed,
    () =>
      workerCapabilityProvider as WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView>,
    options,
  );
}

export function createTestRequestExecutionScopeWithCapabilities(
  seed: RequestExecutionSeed,
  createWorkerCapabilities: (
    view: RequestCapabilityCompositionView,
  ) => WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView>,
  options: Readonly<{
    executionPolicy?: CompiledRequestExecutionPolicy;
  }> = {},
): RequestExecutionScope {
  const productionLikeSeed = seed.contextCompactionStore
    ? seed
    : Object.freeze({
        ...seed,
        contextCompactionStore: createRequestContextCompactionStore(),
      });
  const executionPolicy =
    options.executionPolicy ??
    resolveRequestExecutionPolicy(
      productionLikeSeed.executionPolicySelection?.policy,
    );
  return createRequestExecutionScope({
    seed: productionLikeSeed,
    executionPolicy,
    createWorkerCapabilities,
  });
}

/** Rebinds a canonical fixture to a focused test policy without a flat runtime path. */
export function rebindTestRequestExecutionPolicy(
  request: RequestExecutionScope,
  executionPolicy: CompiledRequestExecutionPolicy,
): RequestExecutionScope {
  return createRequestExecutionScope({
    seed: request,
    executionPolicy,
    createWorkerCapabilities: () => request.workerCapabilities.provider,
  });
}

/** Rebuilds a canonical fixture after changing seed-owned test inputs. */
export function deriveTestRequestExecutionScope(
  request: RequestExecutionScope,
  overrides: Partial<RequestExecutionSeed>,
): RequestExecutionScope {
  return createRequestExecutionScope({
    seed: Object.freeze({ ...request, ...overrides }),
    executionPolicy: request.executionPolicy,
    createWorkerCapabilities: () => request.workerCapabilities.provider,
  });
}
