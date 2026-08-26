import type { ChatMessage } from "../../../../model-gateway/types.js";
import type { SessionMemorySettledTurn } from "../../../../sessions/memory/source.js";
import { projectConfiguredStepMessages } from "../../../config/runner/step-instructions.js";
import { assessRequestMessagesBudget } from "../../request-context-budget.js";
import { countModelInputTokens } from "../../../model/input-token-count.js";
import { invokeStructuredModelStep } from "../../../model/invoke-structured-step.js";
import { resolveModelContextAdmission } from "../../../model/model-context-budget.js";
import type { BoundRequestModelInvocationContext } from "../../../request/contracts.js";
import { selectLargestFittingPrefix } from "./batching.js";
import { createSessionMemoryCompactionFormat } from "./format.js";
import { parseSessionMemoryCompactionOutput } from "./parser.js";
import { SESSION_MEMORY_COMPACTION_INSTRUCTIONS } from "./prompt.js";
import { hasSessionMemoryRepairHeadroom } from "./repair-headroom.js";
import type { SessionMemoryCompactor } from "../contracts.js";

const SESSION_MEMORY_MODEL_STEP = "context.compact" as const;

export function createModelSessionMemoryCompactor(): SessionMemoryCompactor {
  return Object.freeze({ compact: generateSessionMemorySummary });
}

export async function generateSessionMemorySummary(params: {
  request: BoundRequestModelInvocationContext;
  previousSummary?: string;
  turns: readonly SessionMemorySettledTurn[];
}): Promise<string> {
  if (params.turns.length === 0) {
    throw new Error("session_memory_compaction_turns_empty");
  }
  let summary = params.previousSummary;
  let remaining = params.turns;
  while (remaining.length > 0) {
    const batch = await selectLargestFittingPrefix({
      entries: remaining,
      fits: (candidate) =>
        sessionMemoryBatchFits(params.request, summary, candidate),
    });
    if (batch.length === 0) {
      throw new Error("session_memory_compaction_turn_exceeds_budget");
    }
    summary = await invokeSessionMemoryBatch(params.request, summary, batch);
    remaining = remaining.slice(batch.length);
  }
  return summary!;
}

async function sessionMemoryBatchFits(
  request: BoundRequestModelInvocationContext,
  previousSummary: string | undefined,
  turns: readonly SessionMemorySettledTurn[],
): Promise<boolean> {
  const format = createSessionMemoryCompactionFormat();
  const messages = buildSessionMemoryCompactionMessages(previousSummary, turns);
  const projected = projectConfiguredStepMessages({
    runnerConfig: request.runnerConfig,
    modelStep: SESSION_MEMORY_MODEL_STEP,
    messages,
  }).messages;
  const admission = resolveModelContextAdmission({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: SESSION_MEMORY_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
    requestFormat: format,
  });
  const measuredInputTokens = await countModelInputTokens({
    request,
    invocation: admission.invocation,
    modelStep: SESSION_MEMORY_MODEL_STEP,
    messages: projected,
    format,
  });
  const assessment = assessRequestMessagesBudget({
    messages: projected,
    format: { schema: format.schema },
    budget: admission.budget,
    ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
  });
  return hasSessionMemoryRepairHeadroom({
    assessment,
    ...(admission.budget.tokenEstimation
      ? { tokenEstimation: admission.budget.tokenEstimation }
      : {}),
  });
}

async function invokeSessionMemoryBatch(
  request: BoundRequestModelInvocationContext,
  previousSummary: string | undefined,
  turns: readonly SessionMemorySettledTurn[],
): Promise<string> {
  const parsed = await invokeStructuredModelStep({
    request,
    modelStep: SESSION_MEMORY_MODEL_STEP,
    format: createSessionMemoryCompactionFormat(),
    messages: buildSessionMemoryCompactionMessages(previousSummary, turns),
    timeoutReason: "session_memory_compaction_timeout",
    invalidOutputReason: "invalid_session_memory_compaction_output",
    parse(text) {
      const result = parseSessionMemoryCompactionOutput(text);
      return result.ok
        ? Object.freeze({ ok: true as const, decision: result.summary })
        : Object.freeze({
            ok: false as const,
            stage: "session_memory_compaction",
            issues: Object.freeze([
              Object.freeze({
                code: result.issueCode,
                path: "summary",
                message: "Return one bounded replacement summary.",
              }),
            ]),
          });
    },
  });
  return parsed;
}

function buildSessionMemoryCompactionMessages(
  previousSummary: string | undefined,
  turns: readonly SessionMemorySettledTurn[],
): ChatMessage[] {
  return [
    Object.freeze({
      role: "system" as const,
      content: SESSION_MEMORY_COMPACTION_INSTRUCTIONS,
    }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_session_memory_compaction_input_v1",
        authority: "prior_conversation",
        previousCheckpoint: previousSummary ?? null,
        settledTurns: turns.map(({ userMessages, assistant }) => ({
          userMessages: userMessages.map((message) => ({
            messageId: message.id,
            content: message.content,
          })),
          assistant: {
            messageId: assistant.id,
            content: assistant.content,
          },
        })),
        presenceEffect:
          "summarization_input_only_not_current_request_or_action_authority",
      }),
    }),
  ];
}
