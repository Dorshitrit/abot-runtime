import { traceDebug } from "../../observability/debug-logger.js";
import type { RoleCallCommitEffect, RoleCallLedgerHead } from "./contracts.js";

export function traceMemoryRecallCommit(
  params: Readonly<{ head: RoleCallLedgerHead; effect: RoleCallCommitEffect }>,
  common: Readonly<Record<string, unknown>>,
): boolean {
  const effect = params.effect;
  if (!isMemoryRecallEffect(effect)) return false;
  const recall = params.head.state.memoryRecalls.find(
    (entry) => entry.recallId === effect.recallId,
  );
  const call = params.head.state.calls.find(
    (entry) => entry.callId === effect.callId,
  );
  traceDebug(
    "runtime.role_calls",
    effect.type === "memory_recall_begun"
      ? "memory.recall_begun"
      : "memory.recall_settled",
    {
      ...common,
      callId: effect.callId,
      recallId: effect.recallId,
      invocationAttempt: effect.invocationAttempt,
      steeringVersion: effect.steeringVersion,
      activationCount: call?.activationCount,
      queryLength: recall?.query.length,
      outcome: recall?.result?.outcome,
      recordCount: recall?.result?.records.length,
      omittedRecordCount: recall?.result?.omittedRecordCount,
    },
  );
  return true;
}

function isMemoryRecallEffect(
  effect: RoleCallCommitEffect,
): effect is Extract<
  RoleCallCommitEffect,
  { type: "memory_recall_begun" | "memory_recall_settled" }
> {
  return (
    effect.type === "memory_recall_begun" ||
    effect.type === "memory_recall_settled"
  );
}
