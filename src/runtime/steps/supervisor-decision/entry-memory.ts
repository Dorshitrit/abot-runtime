import { isDeepStrictEqual } from "node:util";
import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { markInvocationContextMessage } from "../../../model-gateway/protocol/invocation-context.js";
import { assessRequestMessagesBudget, projectLatestSettledConversationTurn } from "../../context/request-context.js";
import { projectRootSessionMemory } from "../../context/session-memory/root-projection.js";
import { canAuthorConversationMemory, prepareConversationMemoryAuthoring, type ConversationMemoryAuthoringContext } from "../../long-term-memory/conversation-authoring/context.js";
import { requiresContextCompaction } from "../../model/context-compaction-admission.js";
import { invokeStructuredModelStep } from "../../model/invoke-structured-step.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "./contracts.js";
import { createSupervisorEntryMemoryFormat, parseSupervisorEntryMemoryOutput, SUPERVISOR_ENTRY_MEMORY_INSTRUCTIONS, type SupervisorEntryMemoryDecision } from "./entry-memory-contract.js";
import { parseFusedSupervisorEntry } from "./fused-contracts.js";
import { buildSupervisorMemoryConfiguredGuidance, hasCompatibleSupervisorMemoryConfiguration } from "./memory-authoring-configuration.js";
import type { SupervisorPresentationOptions } from "./presentation.js";
import type { buildSupervisorProcedureGateInput } from "./procedure-gate.js";
import { projectSupervisorProcedureMemory } from "./procedure-memory.js";
import type { runSupervisorDecision } from "./run.js";

type EntryOptions = Readonly<{
  input: ReturnType<typeof buildSupervisorProcedureGateInput>;
  format: ModelGatewayJsonSchemaFormat;
  eligibleIds: readonly string[];
  presentation: SupervisorPresentationOptions;
  boundSteeringVersion: number;
  source: Parameters<typeof runSupervisorDecision>[1];
}>;
type EntryMemory = Readonly<{
  messages: ChatMessage[];
  format: ModelGatewayJsonSchemaFormat;
  context?: ConversationMemoryAuthoringContext;
}>;

class SupervisorEntryMemoryBudgetFallback extends Error {}

/** Invocation-local optimization; the existing entry and RAW contracts own outcomes. */
export async function invokeSupervisorEntryDecision(
  request: RequestExecutionScope, options: EntryOptions,
): Promise<SupervisorEntryMemoryDecision> {
  const memory = await prepareSupervisorEntryMemory(request, options);
  let hasParsedOutput = false;
  const invoke = (fused?: EntryMemory) => invokeStructuredModelStep<SupervisorEntryMemoryDecision>({
    request, modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    messages: fused?.messages ?? options.input.context.messages,
    format: fused?.format ?? options.format,
    boundSteeringVersion: options.boundSteeringVersion,
    contextRetention: "exact", configuredInstructionPolicy: "omit",
    timeoutReason: "supervisor_decision_timeout", invalidOutputReason: "invalid_supervisor_decision",
    ...(fused ? { optionalContextProjection: (messages: readonly ChatMessage[]) => {
      if (!hasParsedOutput) throw new SupervisorEntryMemoryBudgetFallback();
      return messages;
    } } : {}),
    parse(text) {
      hasParsedOutput = true;
      return fused ? parseSupervisorEntryMemoryOutput(text, options.eligibleIds, options.presentation, fused.context)
        : parseFusedSupervisorEntry(text, options.eligibleIds, options.presentation);
    },
  });
  try { return await invoke(memory); }
  catch (error) {
    request.abortSignal.throwIfAborted();
    if (!(error instanceof SupervisorEntryMemoryBudgetFallback)) throw error;
    assertBoundModelStepSteeringCurrent(resolveRequestSteeringInbox(request.requestSteering), options.boundSteeringVersion);
    traceEntryMemoryDeferred(request, "measured_context_budget");
    return invoke();
  }
}

async function prepareSupervisorEntryMemory(request: RequestExecutionScope, options: EntryOptions): Promise<EntryMemory | undefined> {
  if (!request.longTermMemory?.enabled) return undefined;
  if (!hasCompleteEntryMemorySources(request, options)) {
    traceEntryMemoryDeferred(request, "incomplete_entry_context");
    return undefined;
  }
  if (!hasCompatibleSupervisorMemoryConfiguration(request)) {
    traceEntryMemoryDeferred(request, "different_model_configuration");
    return undefined;
  }
  const baseMessages = restoreCompleteEntryMemoryReference(options);
  if (!baseMessages) return undefined;
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
  request.abortSignal.throwIfAborted();
  const snapshot = steering.snapshot();
  const context = await prepareConversationMemoryAuthoring(request, snapshot);
  request.abortSignal.throwIfAborted();
  assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
  if (!canAuthorConversationMemory(request, context)) return undefined;
  const format = createSupervisorEntryMemoryFormat(options.format);
  const first = baseMessages[0];
  if (first?.role !== "system") throw new Error("supervisor_entry_memory_policy_missing");
  const baseContract = `Exact output JSON Schema: ${JSON.stringify(options.format.schema)}`;
  if (first.content.split(baseContract).length !== 2) throw new Error("supervisor_entry_memory_contract_missing");
  const instructions = first.content.replace(baseContract, `Exact output JSON Schema: ${JSON.stringify(format.schema)}`);
  const messages: ChatMessage[] = [
    { ...first, content: [instructions, SUPERVISOR_ENTRY_MEMORY_INSTRUCTIONS,
      buildSupervisorMemoryConfiguredGuidance(request)].filter(Boolean).join("\n\n") },
    ...(context ? [markInvocationContextMessage(context.message)] : []), ...baseMessages.slice(1),
  ];
  const assessment = assessRequestMessagesBudget({
    messages: appendRequestSteeringContext(messages, snapshot), format,
    budget: resolveModelContextBudget({
      runnerConfig: request.runnerConfig, agentMode: request.agentMode, modelStep: SUPERVISOR_DECISION_MODEL_STEP,
      configuredInstructionPolicy: "omit", modelPreference: request.modelPreference,
      modelPolicy: request.modelPolicy, reasoningPreference: request.reasoningPreference,
    }),
  });
  if (requiresContextCompaction(true, assessment)) {
    traceEntryMemoryDeferred(request, "context_budget");
    return undefined;
  }
  return { messages, format, ...(context ? { context } : {}) };
}

/** Do not enlarge the short entry's conversation or replace full memory authoring with a truncated view. */
function hasCompleteEntryMemorySources(request: RequestExecutionScope, options: EntryOptions): boolean {
  if (options.source.resume || options.source.memoryRecallMessage) return false;
  if (options.source.toolResults.results.length > 0) return false;
  if (options.input.context.omittedHistoryMessageIds.length > 0) return false;
  const session = projectRootSessionMemory(request);
  if (session.priorConversationMessages.length > 0) return false;
  return isDeepStrictEqual(session.historyMessages, projectLatestSettledConversationTurn(request.historyMessages) ?? []);
}

/** Replace the complete compact rendering once, preserving the original invocation binding. */
function restoreCompleteEntryMemoryReference(options: EntryOptions): ChatMessage[] | undefined {
  const messages = options.input.context.messages;
  const reference = options.source.initialMemoryMessage;
  if (!reference) return messages;
  const projected = projectSupervisorProcedureMemory(reference);
  if (!projected) return undefined;
  const matches = messages.filter(message => message.role === projected.message.role && message.content === projected.message.content);
  if (matches.length !== 1) return undefined;
  return messages.map(message => message === matches[0] ? reference : message);
}

function traceEntryMemoryDeferred(request: RequestExecutionScope, reason: string): void {
  traceDebug("runtime.supervisor", "entry.memory_authoring_deferred", { requestId: request.requestId, reason });
}
