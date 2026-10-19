import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../../model-gateway/types.js";
import {
  resolveCapabilityBriefHeadroom,
  resolveCapabilityBriefMessageHeadroom,
} from "../../context/capability-brief-budget.js";
import type { projectRequestContext } from "../../context/request-context.js";
import { buildSessionArtifactPathsMessage } from "../../context/session-artifact-paths.js";
import { estimateMessageTokens } from "../../context/token-estimator.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { buildSupervisorCapabilityBriefOptions } from "./capability-brief.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "./contracts.js";
import { buildSupervisorArtifactPathInstructions } from "./prompt.js";

export type SupervisorArtifactPathsProjection = Readonly<{
  instructions: string;
  baseInstructions: string;
  message: ChatMessage;
}>;

/** Adds a bounded continuity reference only within the remaining full-context budget. */
export function projectSupervisorArtifactPaths(params: Readonly<{
  targets: readonly string[] | undefined;
  context: Parameters<typeof projectRequestContext>[0];
  additionalBudgetMessages?: readonly ChatMessage[];
}>): SupervisorArtifactPathsProjection | undefined {
  if (!params.targets?.length) return undefined;
  const instructions = [
    params.context.instructions,
    buildSupervisorArtifactPathInstructions(),
  ].join("\n");
  // The existing catalog and all history retain priority over this reference.
  const headroom = resolveCapabilityBriefHeadroom({
    context: { ...params.context, instructions },
    additionalBudgetMessages: params.additionalBudgetMessages,
  });
  const artifactPaths = buildSessionArtifactPathsMessage({
    targets: params.targets,
    applicable: true,
    applicability: "supervisor_objective_and_working_directory_reference_only",
    maxTargets: 8,
    fits: (message) =>
      estimateMessageTokens(message, params.context.budget.tokenEstimation) <=
      headroom,
  });
  if (!artifactPaths) return undefined;
  return {
    instructions,
    baseInstructions: params.context.instructions,
    message: artifactPaths.message,
  };
}

/** Optional paths yield to the current attempt's mandatory context and catalog. */
export function createSupervisorArtifactPathsReadmissionController(
  request: RequestExecutionScope,
  options: Readonly<{
    controller: ModelStepContextCompactionController;
    projection?: SupervisorArtifactPathsProjection;
    format: ModelGatewayJsonSchemaFormat;
    includeInstructions: boolean;
  }>,
): ModelStepContextCompactionController {
  const { controller, projection } = options;
  if (!projection) return controller;
  let admittedArtifactMessage: ChatMessage | undefined;
  return Object.freeze({
    ...controller,
    project(messages) {
      admittedArtifactMessage = undefined;
      const artifactIndex = messages.findIndex((message) =>
        matchesBoundArtifactMessage(message, projection.message),
      );
      if (artifactIndex < 0) return controller.project(messages);
      const followingMessage = messages[artifactIndex + 1];
      const withoutArtifact = messages.filter(
        (_, index) => index !== artifactIndex,
      );
      const withoutAdditions = options.includeInstructions
        ? replaceBoundInstructionPrefix(
            withoutArtifact,
            projection.instructions,
            projection.baseInstructions,
          )
        : withoutArtifact;
      const projected = controller.project(withoutAdditions);
      const withInstructions = options.includeInstructions
        ? replaceBoundInstructionPrefix(
            projected,
            projection.baseInstructions,
            projection.instructions,
          )
        : projected;
      const admission = resolveModelContextAdmission({
        runnerConfig: request.runnerConfig,
        agentMode: request.agentMode,
        modelStep: SUPERVISOR_DECISION_MODEL_STEP,
        modelPreference: request.modelPreference,
        modelPolicy: request.modelPolicy,
        requestFormat: options.format,
      });
      const { capabilityBriefBudgetMessages = [] } =
        buildSupervisorCapabilityBriefOptions(request, {});
      const headroom = resolveCapabilityBriefMessageHeadroom({
        messages: [...withInstructions, ...capabilityBriefBudgetMessages],
        budget: admission.budget,
        format: options.format,
      });
      const artifactPaths = buildSessionArtifactPathsMessage({
        targets: request.sessionArtifactPaths ?? [],
        applicable: true,
        applicability:
          "supervisor_objective_and_working_directory_reference_only",
        maxTargets: 8,
        fits: (message) =>
          estimateMessageTokens(message, admission.budget.tokenEstimation) <=
          headroom,
      });
      if (!artifactPaths) return projected;
      // The current prompt follows the reference and survives compaction verbatim.
      const insertionIndex = followingMessage
        ? withInstructions.indexOf(followingMessage)
        : withInstructions.length;
      if (insertionIndex < 0)
        throw new Error("supervisor_artifact_path_position_binding_invalid");
      admittedArtifactMessage = artifactPaths.message;
      return [
        ...withInstructions.slice(0, insertionIndex),
        artifactPaths.message,
        ...withInstructions.slice(insertionIndex),
      ];
    },
    projectForCompaction(messages) {
      const artifactIndex = admittedArtifactMessage
        ? messages.indexOf(admittedArtifactMessage)
        : -1;
      if (artifactIndex < 0)
        return controller.projectForCompaction?.(messages) ?? messages;
      const withoutArtifact = messages.filter(
        (_, index) => index !== artifactIndex,
      );
      const withoutAdditions = options.includeInstructions
        ? replaceBoundInstructionPrefix(
            withoutArtifact,
            projection.instructions,
            projection.baseInstructions,
          )
        : withoutArtifact;
      return (
        controller.projectForCompaction?.(withoutAdditions) ?? withoutAdditions
      );
    },
    getStages: () => controller.getStages(),
    ...(controller.hasExhaustedVerifiedCompactionSources
      ? {
          hasExhaustedVerifiedCompactionSources: (
            messages: readonly ChatMessage[],
          ) =>
            controller.hasExhaustedVerifiedCompactionSources!(messages),
        }
      : {}),
  });
}

function matchesBoundArtifactMessage(
  left: ChatMessage,
  right: ChatMessage,
): boolean {
  return (
    left === right ||
    (left.role === right.role && left.content === right.content)
  );
}

function replaceBoundInstructionPrefix(
  messages: readonly ChatMessage[],
  previous: string,
  replacement: string,
): ChatMessage[] {
  const instructions = messages[0];
  if (
    instructions?.role !== "system" ||
    !instructions.content.startsWith(previous)
  )
    throw new Error("supervisor_artifact_path_instruction_binding_invalid");
  return [
    {
      ...instructions,
      content: replacement + instructions.content.slice(previous.length),
    },
    ...messages.slice(1),
  ];
}
