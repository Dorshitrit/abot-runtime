import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";

export const WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX = 8;

export function projectEligibleWorkerSessionArtifactPaths(
  sessionArtifactPaths: readonly string[] | undefined,
  requestToolResults: RequestToolResultsView,
): readonly string[] {
  if (!sessionArtifactPaths || sessionArtifactPaths.length === 0) {
    return Object.freeze([]);
  }

  const newestSessionArtifactPaths = sessionArtifactPaths.slice(
    0,
    WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX,
  );
  const currentRequestTargets = new Set<string>();
  for (const result of requestToolResults.results) {
    for (const reference of result.references ?? []) {
      if (reference.kind === "tool_target") {
        currentRequestTargets.add(reference.target);
      }
    }
  }

  return Object.freeze(
    newestSessionArtifactPaths.filter(
      (target) => !currentRequestTargets.has(target),
    ),
  );
}

export function projectEffectiveWorkerSelectionControlIds(
  descriptor: Pick<
    WorkerCapabilityDescriptor,
    "selectionControlIds" | "runtimePathControlIds"
  >,
  deferRuntimePathControls: boolean,
): readonly string[] {
  const selectionControlIds = descriptor.selectionControlIds ?? [];
  if (!deferRuntimePathControls || selectionControlIds.length === 0) {
    return selectionControlIds;
  }

  const runtimePathControlIds = new Set(descriptor.runtimePathControlIds ?? []);
  if (runtimePathControlIds.size === 0) {
    return selectionControlIds;
  }

  const effective = selectionControlIds.filter(
    (controlId) => !runtimePathControlIds.has(controlId),
  );
  return effective.length === selectionControlIds.length
    ? selectionControlIds
    : Object.freeze(effective);
}
