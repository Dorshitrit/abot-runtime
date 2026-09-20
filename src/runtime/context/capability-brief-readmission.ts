import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ToolAvailabilityOverviewGroup } from "../../plugin-sdk/tool-availability-overview.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";
import {
  isCapabilityBriefMessage,
  projectCapabilityBriefAtHeadroom,
  type CapabilityBriefProjection,
} from "./capability-brief.js";
import { resolveCapabilityBriefMessageHeadroom } from "./capability-brief-budget.js";
import type { RequestContextBudget } from "./request-context-contracts.js";

export type CapabilityBriefReadmissionOptions = Readonly<{
  entries?: readonly ToolAvailabilityEntry[];
  groups: readonly ToolAvailabilityOverviewGroup[];
  budget: RequestContextBudget;
  format?: Readonly<{ schema: unknown }>;
  additionalBudgetMessages?: readonly ChatMessage[];
}>;

/** Re-admits an existing optional brief against the current attempt's context. */
export function createCapabilityBriefReadmissionController(
  params: Readonly<{
    controller: ModelStepContextCompactionController;
    resolveOptions(): CapabilityBriefReadmissionOptions;
    onReadmitted?(projection: CapabilityBriefProjection): void;
  }>,
): ModelStepContextCompactionController {
  const { controller } = params;
  return Object.freeze({
    get compactionScope() {
      return controller.compactionScope;
    },
    project(messages) {
      const projected = controller.project(messages);
      const briefIndex = projected.findIndex(isCapabilityBriefMessage);
      if (briefIndex < 0) return projected;
      const withoutBrief = projected.filter((_, index) => index !== briefIndex);
      const options = params.resolveOptions();
      const headroom = resolveCapabilityBriefMessageHeadroom({
        messages: [
          ...withoutBrief,
          ...(options.additionalBudgetMessages ?? []),
        ],
        budget: options.budget,
        format: options.format,
      });
      const replacement = projectCapabilityBriefAtHeadroom({
        entries: options.entries,
        groups: options.groups,
        headroom,
        tokenEstimation: options.budget.tokenEstimation,
      });
      if (replacement.message?.content === projected[briefIndex]!.content) {
        return projected;
      }
      params.onReadmitted?.(replacement);
      if (!replacement.message) return withoutBrief;
      return [
        ...projected.slice(0, briefIndex),
        replacement.message,
        ...projected.slice(briefIndex + 1),
      ];
    },
    prepare(messages) {
      return controller.prepare(messages);
    },
  });
}
