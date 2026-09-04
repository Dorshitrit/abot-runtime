import { readFile, stat } from "node:fs/promises";

import type {
  ToolExecutionSharedState,
  ToolPayloadChannelSpec,
} from "../../capabilities/tool-types.js";
import { resolveRuntimeTargetPath } from "../capabilities/runtime-target-path.js";
import {
  projectWorkerCapabilityDependencyArtifactReceipts,
  type WorkerCapabilityDependencyArtifactReceipt,
} from "../orchestration/worker-capabilities/assignment-provenance.js";
import { projectWorkerPayloadPlannerItemProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import type {
  WorkerCapabilityPayloadSourceProvenance,
  WorkerSettledCapabilityResult,
} from "../orchestration/worker-capabilities/contracts.js";
import {
  WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS,
  WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT,
  type WorkerCapabilityPayloadRelatedArtifactContext,
} from "../orchestration/worker-capabilities/payload-contracts.js";
import type { RoleCallFrame } from "../orchestration/role-calls/contracts.js";

export async function resolveRegisteredToolPayloadRelatedArtifactContexts(params: {
  contextScope?: ToolPayloadChannelSpec["contextScope"];
  targetParam?: string;
  controls: Readonly<Record<string, unknown>>;
  sharedState: ToolExecutionSharedState;
  call: RoleCallFrame;
  assignmentProvenance?: WorkerCapabilityPayloadSourceProvenance;
  settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
}): Promise<readonly WorkerCapabilityPayloadRelatedArtifactContext[]> {
  if (params.contextScope !== "target_with_artifacts") {
    return Object.freeze([]);
  }
  const dependencyReceipts = projectWorkerCapabilityDependencyArtifactReceipts(
    projectWorkerPayloadPlannerItemProvenance(
      params.assignmentProvenance,
      params.call,
    ),
    params.call,
  );
  const receipts = [
    ...projectSameCallArtifactReceipts(params.settledCapabilityResults),
    ...dependencyReceipts,
  ];
  return loadRelatedArtifactContexts(params, receipts);
}

function projectSameCallArtifactReceipts(
  results: readonly WorkerSettledCapabilityResult[],
): readonly WorkerCapabilityDependencyArtifactReceipt[] {
  return results.flatMap((result) => {
    if (result.outcome !== "succeeded") return [];
    return (result.references ?? []).map((reference) =>
      Object.freeze({
        sourceExecutionId: result.executionId,
        targetPath: reference.target,
      }),
    );
  });
}

async function loadRelatedArtifactContexts(
  params: Readonly<{
    targetParam?: string;
    controls: Readonly<Record<string, unknown>>;
    sharedState: ToolExecutionSharedState;
  }>,
  receipts: readonly WorkerCapabilityDependencyArtifactReceipt[],
): Promise<readonly WorkerCapabilityPayloadRelatedArtifactContext[]> {
  const currentTarget = resolveCurrentTarget(params);
  const resolvedTargets = new Set<string>();
  const artifacts: WorkerCapabilityPayloadRelatedArtifactContext[] = [];
  let totalCharacters = 0;

  for (const receipt of receipts) {
    let resolvedTarget: string;
    try {
      resolvedTarget = resolveRuntimeTargetPath(
        receipt.targetPath,
        params.sharedState,
      );
    } catch {
      continue;
    }
    if (
      resolvedTarget === currentTarget ||
      resolvedTargets.has(resolvedTarget)
    ) {
      continue;
    }
    resolvedTargets.add(resolvedTarget);

    try {
      const targetStat = await stat(resolvedTarget);
      if (!targetStat.isFile()) continue;
      const content = await readFile(resolvedTarget, "utf8");
      if (
        content.length + totalCharacters >
        WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS
      ) {
        continue;
      }
      artifacts.push(
        Object.freeze({
          sourceExecutionId: receipt.sourceExecutionId,
          targetPath: receipt.targetPath,
          presentation: "full" as const,
          content,
        }),
      );
      totalCharacters += content.length;
      if (
        artifacts.length >= WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT
      ) {
        return Object.freeze(artifacts);
      }
    } catch {
      continue;
    }
  }
  return Object.freeze(artifacts);
}

function resolveCurrentTarget(params: {
  targetParam?: string;
  controls: Readonly<Record<string, unknown>>;
  sharedState: ToolExecutionSharedState;
}): string | undefined {
  const rawTarget = params.targetParam
    ? params.controls[params.targetParam]
    : undefined;
  if (typeof rawTarget !== "string" || rawTarget.trim().length === 0) {
    return undefined;
  }
  try {
    return resolveRuntimeTargetPath(rawTarget.trim(), params.sharedState);
  } catch {
    return undefined;
  }
}
