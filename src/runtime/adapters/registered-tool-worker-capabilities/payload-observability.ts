import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import type { RegisteredToolNormalInvocationExecutor } from "../registered-tool-normal-invocations.js";
import {
  traceRegisteredToolWorkerCapabilityPayloadStageMaterialized,
  type RegisteredToolWorkerCapabilityProviderDiagnostic,
} from "../registered-tool-worker-capability-diagnostics.js";

type DeferredPayloadObservation = (executionId: string) => void;

export type PayloadStageMaterializationDetails = Readonly<{
  payloadStage: number;
  payloadStageCount: number;
  source: "manifest_literal";
  byteCount: number;
}>;

/**
 * Keeps tool-payload lifecycle and its adapter diagnostic provisional during
 * preparation. Canonically admitted execution releases them in their original
 * order; discarded preparations never publish them.
 */
export function createDeferredPayloadObservability(params: {
  executor: RegisteredToolNormalInvocationExecutor;
  diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic;
  operationId: string;
  call: RoleCallFrame;
}) {
  const deferred: DeferredPayloadObservation[] = [];
  const lifecycleEmitter = Object.freeze({
    emitPayloadLifecycle(
      input: Parameters<
        RegisteredToolNormalInvocationExecutor["emitPayloadLifecycle"]
      >[0],
    ) {
      const prepared = params.executor.preparePayloadLifecycle(input);
      if (prepared.status === "rejected") return prepared;
      deferred.push((executionId) => {
        prepared.emit(executionId, params.call);
      });
      return Object.freeze({ status: "emitted" as const });
    },
  });

  return Object.freeze({
    lifecycleEmitter,
    deferPayloadStageMaterialized(details: PayloadStageMaterializationDetails) {
      deferred.push((executionId) => {
        traceRegisteredToolWorkerCapabilityPayloadStageMaterialized(
          params.diagnostic,
          params.operationId,
          params.call,
          executionId,
          details,
        );
      });
    },
    release(executionId: string): void {
      for (const publish of deferred) publish(executionId);
    },
  });
}

export type PayloadLifecycleEmitter = Readonly<{
  emitPayloadLifecycle: RegisteredToolNormalInvocationExecutor["emitPayloadLifecycle"];
}>;
