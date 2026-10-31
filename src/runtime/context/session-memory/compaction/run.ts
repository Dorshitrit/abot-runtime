import { projectConfiguredStepMessages } from "../../../config/runner/step-instructions.js";
import { assessRequestMessagesBudget } from "../../request-context-budget.js";
import { countModelInputTokens } from "../../../model/input-token-count.js";
import { invokeStructuredModelStep } from "../../../model/invoke-structured-step.js";
import { resolveModelContextAdmission } from "../../../model/model-context-budget.js";
import type { BoundRequestModelInvocationContext } from "../../../request/contracts.js";
import { isExecutionSessionMemoryScope } from "../../../../sessions/memory/checkpoint-scope.js";
import { selectLargestFittingPrefix } from "./batching.js";
import { createSessionMemoryCompactionFormat } from "./format.js";
import { parseSessionMemoryCompactionOutput } from "./parser.js";
import { hasSessionMemoryRepairHeadroom } from "./repair-headroom.js";
import type { SessionMemoryCompactor } from "../contracts.js";
import {
  buildSessionMemoryCompactionMessages,
  type SessionMemoryCompactionBatch,
} from "./input.js";
import { foldOversizedExecutionHistoryTurn } from "./turn-fold.js";

const SESSION_MEMORY_MODEL_STEP = "context.compact" as const;

export function createModelSessionMemoryCompactor(): SessionMemoryCompactor {
  return Object.freeze({ compact: generateSessionMemorySummary });
}

export async function generateSessionMemorySummary(
  params: Parameters<SessionMemoryCompactor["compact"]>[0],
): Promise<string> {
  if (params.turns.length === 0) {
    throw new Error("session_memory_compaction_turns_empty");
  }
  let summary = params.previousSummary;
  let remaining = params.turns;
  while (remaining.length > 0) {
    params.onProgress?.({ step: "processing", unit: "turns", completedUnits: params.turns.length - remaining.length, totalUnits: params.turns.length });
    const batch = await selectLargestFittingPrefix({
      entries: remaining,
      fits: (candidate) =>
        sessionMemoryBatchFits(params.request, summary, {
          turns: candidate, scope: params.scope,
        }),
    });
    const hasFittingHistoryTurns = batch.length > 0;
    if (hasFittingHistoryTurns) {
      summary = await invokeSessionMemoryBatch(params.request, summary, {
        turns: batch, scope: params.scope,
      });
      remaining = remaining.slice(batch.length);
      params.onProgress?.({ step: "processing", unit: "turns", completedUnits: params.turns.length - remaining.length, totalUnits: params.turns.length });
      continue;
    }
    if (!isExecutionSessionMemoryScope(params.scope))
      throw new Error("session_memory_compaction_turn_exceeds_budget");
    summary = await foldOversizedExecutionHistoryTurn({
      turn: remaining[0]!,
      onProgress: (progress) => params.onProgress?.({
        ...progress, unit: "turns", completedUnits: params.turns.length - remaining.length, totalUnits: params.turns.length,
      }),
      previousSummary: summary,
      fits: (previous, candidate) => sessionMemoryBatchFits(params.request, previous, candidate),
      invoke: (previous, candidate) => invokeSessionMemoryBatch(params.request, previous, candidate),
    });
    remaining = remaining.slice(1);
    params.onProgress?.({ step: "processing", unit: "turns", completedUnits: params.turns.length - remaining.length, totalUnits: params.turns.length });
  }
  return summary!;
}

async function sessionMemoryBatchFits(
  request: BoundRequestModelInvocationContext,
  previousSummary: string | undefined,
  batch: SessionMemoryCompactionBatch,
): Promise<boolean> {
  const format = createSessionMemoryCompactionFormat();
  const messages = buildSessionMemoryCompactionMessages(previousSummary, batch);
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
  batch: SessionMemoryCompactionBatch,
): Promise<string> {
  const parsed = await invokeStructuredModelStep({
    request,
    modelStep: SESSION_MEMORY_MODEL_STEP,
    format: createSessionMemoryCompactionFormat(),
    messages: buildSessionMemoryCompactionMessages(previousSummary, batch),
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
