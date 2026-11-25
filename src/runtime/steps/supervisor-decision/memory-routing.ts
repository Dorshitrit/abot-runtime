import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { markInvocationContextMessage } from "../../../model-gateway/protocol/invocation-context.js";
import { canAuthorConversationMemory, prepareConversationMemoryAuthoring, type ConversationMemoryAuthoringContext } from "../../long-term-memory/conversation-authoring/context.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { SupervisorResumeContext } from "./contracts.js";
import type { buildSupervisorDecisionInput } from "./input.js";
import { buildSupervisorMemoryConfiguredGuidance, hasCompatibleSupervisorMemoryConfiguration } from "./memory-authoring-configuration.js";
import { buildSupervisorMemoryRoutingInstructions, createSupervisorMemoryRoutingFormat } from "./memory-fusion.js";

export type SupervisorMemoryRouting = Readonly<{
  messages: ChatMessage[];
  format: ModelGatewayJsonSchemaFormat;
  instructionAppendix: string;
  context?: ConversationMemoryAuthoringContext;
}>;

/** Internal pre-dispatch fallback: preserve the existing compaction/authoring path. */
export class SupervisorMemoryRoutingBudgetFallback extends Error {
  constructor() { super("supervisor_memory_routing_budget_fallback"); }
}

/** Called under admission pressure, before dispatch of the current provider attempt. */
export function deferSupervisorMemoryRouting(request: RequestExecutionScope): never {
  traceFallback(request, "context_budget");
  throw new SupervisorMemoryRoutingBudgetFallback();
}

export async function prepareSupervisorMemoryRouting(
  request: RequestExecutionScope,
  options: Readonly<{
    input: ReturnType<typeof buildSupervisorDecisionInput>;
    resume?: SupervisorResumeContext;
    steeringVersion: number;
    contextCompaction: ModelStepContextCompactionController;
  }>,
): Promise<SupervisorMemoryRouting | undefined> {
  if (!options.resume?.completedChildren.length || options.input.delegationOnly) return undefined;
  if (!request.longTermMemory?.enabled) return undefined;
  if (!hasCompatibleSupervisorMemoryConfiguration(request)) {
    traceFallback(request, "different_model_configuration");
    return undefined;
  }
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  assertBoundModelStepSteeringCurrent(steering, options.steeringVersion);
  request.abortSignal.throwIfAborted();
  const snapshot = steering.snapshot();
  const context = await prepareConversationMemoryAuthoring(request, snapshot);
  request.abortSignal.throwIfAborted();
  assertBoundModelStepSteeringCurrent(steering, options.steeringVersion);
  if (!canAuthorConversationMemory(request, context)) return undefined;
  // Reuse already committed projections, without starting a new compaction cycle.
  const baseMessages = options.contextCompaction.project(options.input.context.messages);
  const first = baseMessages[0];
  if (first?.role !== "system" || options.input.context.omittedHistoryMessageIds.length > 0) return undefined;
  const instructionAppendix = [buildSupervisorMemoryRoutingInstructions(),
    buildSupervisorMemoryConfiguredGuidance(request)].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [
    { ...first, content: `${first.content}\n\n${instructionAppendix}` },
    ...(context ? [markInvocationContextMessage(context.message)] : []),
    ...baseMessages.slice(1),
  ];
  const format = createSupervisorMemoryRoutingFormat(options.input.format);
  // Canonical invocation admission measures the complete provider envelope before
  // deciding whether to defer memory. Without a count it retains the same estimate.
  return { messages, format, instructionAppendix, ...(context ? { context } : {}) };
}

function traceFallback(request: RequestExecutionScope, reason: string): void {
  traceDebug("runtime.supervisor", "decision.memory_authoring_deferred", {
    requestId: request.requestId, reason,
  });
}
