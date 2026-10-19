import {
  assertSuperWorkerCompactionSidecarBinding,
  readSuperWorkerCompactionSidecar,
} from "../../context/super-worker-compaction-sidecar.js";
import type {
  WorkerCapabilityPayloadAuthor,
  WorkerCapabilityPayloadModelRequest,
} from "./payload-contracts.js";

/** Runtime-only sidecar bypasses the cloned/model-visible payload context. */
export function projectWorkerPayloadCompactionInput(
  input: Parameters<WorkerCapabilityPayloadAuthor["author"]>[0],
  requestId: string,
): Pick<WorkerCapabilityPayloadModelRequest, "superWorkerCompaction"> {
  const sidecar = readSuperWorkerCompactionSidecar(
    input.settledCapabilityResults,
  );
  if (!sidecar) return {};
  assertSuperWorkerCompactionSidecarBinding(sidecar, {
    requestId,
    callId: input.call.callId,
  });
  return { superWorkerCompaction: sidecar };
}

/** Root payload checkpoints are isolated to the exact preparation and stage. */
export function rootPayloadCompactionScopeId(
  input: WorkerCapabilityPayloadModelRequest,
): string {
  if (!("root" in input.context)) throw new Error("payload_root_context_required");
  return ["payload", input.context.root.callId, input.executionId,
    input.context.payloadStage?.index ?? 0].join(":");
}
