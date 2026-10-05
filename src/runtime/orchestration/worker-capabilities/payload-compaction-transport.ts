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
  if (input.call.roleId !== "worker") return {};
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
