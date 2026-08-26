import type { ChatMessage } from "../../model-gateway/types.js";

export const SESSION_ARTIFACT_PATHS_MESSAGE_KIND =
  "runtime_session_artifact_paths_v1" as const;

export type SessionArtifactPathsCapsule = Readonly<{
  kind: typeof SESSION_ARTIFACT_PATHS_MESSAGE_KIND;
  category: "request_reference";
  authority: "canonical_runtime_state";
  provenance: "settled_successful_tool_target_references";
  purpose: "passive_tool_target_continuity_reference";
  representation: "verbatim_settled_tool_target";
  applicability: "selected_capability_runtime_path_control_authoring_refinement_only";
  nonAuthority: Readonly<{
    addsUserIntent: false;
    addsPendingWork: false;
    choosesOrRedirectsTarget: false;
    provesTargetExists: false;
    provesCompletion: false;
  }>;
  targets: readonly string[];
  omission: Readonly<{
    availableTargetCount: number;
    projectedTargetCount: number;
    omittedTargetCount: number;
  }>;
}>;

export type SessionArtifactPathsProjection = Readonly<{
  message: ChatMessage;
  availableCount: number;
  projectedCount: number;
  omittedCount: number;
}>;

/**
 * Builds the largest ordered prefix accepted by the caller's complete-message
 * budget predicate. The projection is passive: it carries only previously
 * observed tool-target references verbatim and never resolves or changes one.
 */
export function buildSessionArtifactPathsMessage(
  params: Readonly<{
    targets: readonly string[];
    availableTargetCount?: number;
    applicable: boolean;
    maxTargets?: number;
    fits(message: ChatMessage): boolean;
  }>,
): SessionArtifactPathsProjection | undefined {
  if (!params.applicable || params.targets.length === 0) {
    return undefined;
  }
  if (
    params.maxTargets !== undefined &&
    (!Number.isSafeInteger(params.maxTargets) || params.maxTargets < 1)
  ) {
    throw new Error("session_artifact_path_projection_limit_invalid");
  }

  const availableTargetCount =
    params.availableTargetCount ?? params.targets.length;
  if (
    !Number.isSafeInteger(availableTargetCount) ||
    availableTargetCount < params.targets.length
  ) {
    throw new Error("session_artifact_path_available_count_invalid");
  }
  const maximumProjectedTargetCount = Math.min(
    params.targets.length,
    params.maxTargets ?? params.targets.length,
  );
  for (
    let projectedTargetCount = maximumProjectedTargetCount;
    projectedTargetCount > 0;
    projectedTargetCount -= 1
  ) {
    const capsule: SessionArtifactPathsCapsule = Object.freeze({
      kind: SESSION_ARTIFACT_PATHS_MESSAGE_KIND,
      category: "request_reference",
      authority: "canonical_runtime_state",
      provenance: "settled_successful_tool_target_references",
      purpose: "passive_tool_target_continuity_reference",
      representation: "verbatim_settled_tool_target",
      applicability:
        "selected_capability_runtime_path_control_authoring_refinement_only",
      nonAuthority: Object.freeze({
        addsUserIntent: false,
        addsPendingWork: false,
        choosesOrRedirectsTarget: false,
        provesTargetExists: false,
        provesCompletion: false,
      }),
      targets: Object.freeze(params.targets.slice(0, projectedTargetCount)),
      omission: Object.freeze({
        availableTargetCount,
        projectedTargetCount,
        omittedTargetCount: availableTargetCount - projectedTargetCount,
      }),
    });
    const message: ChatMessage = Object.freeze({
      role: "system" as const,
      content: JSON.stringify(capsule),
    });
    if (params.fits(message)) {
      return Object.freeze({
        message,
        availableCount: availableTargetCount,
        projectedCount: projectedTargetCount,
        omittedCount: availableTargetCount - projectedTargetCount,
      });
    }
  }
  return undefined;
}
